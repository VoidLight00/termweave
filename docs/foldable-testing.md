# Foldable testing (Galaxy Z Fold8 / Fold8 Ultra)

Researched 2026-09-27, without a physical device. Covers the screens, what was checked in emulation, and how to test closer to the real thing. Anything marked *unverified* could not be confirmed for 2026.

## Screens

| Device | Screen | Physical px | Aspect | CSS px at DPR 2.625 | at 2.8125 (enlarged zoom) |
|---|---|---|---|---|---|
| Fold8 ("wide") | inner | 1828×2448 | 4:3 | 696×933 (landscape 933×696) | 650×870 |
| | cover | 1248×1972 | ~16:10 | 475×751 | 444×701 |
| Fold8 Ultra | inner | 2256×2504 | ~1:1 | 859×954 | 802×890 |
| | cover | 1080×2520 | 21:9 | 411×960 | 384×896 |

- Fold8 inner width is 1828 per Samsung's emulator skin page and GSMArena; some articles say 1848, which is wrong.
- The DPR is an assumption. 2.625 matches published Fold6 figures (707×823 CSS). No measured Fold7/Fold8 value was found; sources disagree (2.0, 3.0, 3.5) and none says it measured on a device. One UI's screen zoom changes the DPR, so read `devicePixelRatio` on a real device (Remote Test Lab, below) to settle it.
- Where the app's breakpoints land: the Fold8 inner screen held portrait (650–704 CSS) is in the 481–768px band, so it gets drawer mode with desktop header labels. The Fold8 Ultra inner screen (≥800) gets the desktop layout with a docked sidebar. The Fold8 cover (444–475) is at the 480px phone rule. The Ultra cover (384–411) is a phone.

## What was checked (Chrome emulation, 2026-09-27)

Headless Chrome, `isMobile` + touch, Korean locale, the real app against an isolated herdr test session. Viewports: inner portrait and landscape, and cover, for both devices at both DPRs, with 80px taken off the height for browser chrome. At each: terminal, chat, drawer/sidebar, command palette, settings, new session, files.

Automated checks: no horizontal page scroll, no unclipped element off-screen, dialogs inside the viewport, no short label wrapped onto 2+ lines (text-node line count), the header never showing both the drawer and the sidebar-collapse toggle, and the pane title width.

Fixed as a result:
- **#92**: Hangul lens labels wrapped one syllable per line in 481–768px, and ☰ and ◫ showed together. Also: the chat's scrollback fallback now reads `recent_unwrapped`, so lines reflow.
- **#93**: leftover untranslated literals. The palette hides shortcut hints ≤480px. The key bar's direct-typing toggle moved first, since the row (9 × 44px ≈ 428px) scrolls on the Ultra cover.
- **#95**: an omo pane lost its transcript while a background task held a task log open. Found by running a real omo pane in the test session.

Emulation cannot show: One UI scaling and fonts, Samsung Internet, the viewport resize during a real fold/unfold, soft keyboard + `visualViewport` behaviour, or PWA standalone mode.

## Options, cheapest effective first

| # | Option | Real Fold8 | Fold8 Ultra | Cost | Use for |
|---|---|---|---|---|---|
| 1 | Android emulator, local | no (stock Android, no One UI) | "8-inch Foldable" profile is close | free | scripted fold/unfold, keyboard, `visualViewport`, PWA install, real Android Chrome |
| 2 | Samsung Remote Test Lab | yes (One UI, Samsung Internet) | *unverified* | free credits (20/day × 15 min in older docs, *unverified* now) | a manual pass on real scaling and a real fold transition; reading the real DPR |
| 3 | TestMu AI (formerly LambdaTest) | yes (Android 17) | yes | free: 5 live real-device sessions/month, 2 min each; Real Device Plus Live $39/mo annual ($49 monthly). The 100 free lifetime minutes are automation only | a quick look at the Ultra |
| 4 | BrowserStack Live | not listed | yes | $39/mo (annual) | only for repeated or automated runs |
| 5 | Firebase Android Device Streaming | Pixel 9 Pro Fold only | no | 30 free min/month | real Chrome with a real fold, not Samsung |
| 6 | Chrome DevTools device mode | no | no | free | adds little over headless emulation |

Sauce Labs and AWS Device Farm: Fold availability *unverified* (`aws devicefarm list-devices` would settle AWS).

Recommended: use (1) for repeatable automation, do one manual pass on (2), and use (3)'s free sessions for a quick look at the Ultra.

## Reaching the app from a remote device

Remote devices cannot reach Tailscale 100.x addresses. `tailscale funnel <port>` publishes a public `https://<node>.<tailnet>.ts.net` address with a certificate (ports 443, 8443, 10000); HTTPS also makes the PWA installable. This exposes the app to the internet: set `HERDR_WEB_TOKEN`, and turn Funnel off after the session. For the local emulator, `adb reverse` to `localhost` avoids this, and `http://localhost` counts as a secure context.

## Recipe: local emulator

Host (2026-09-27): `/dev/kvm` present, 32 cores, 109 GB RAM, 44 GB free disk. The Android SDK is not installed (~10 GB needed).

```bash
emulator -accel-check                                    # expect: KVM ... is installed and usable
sdkmanager "emulator" "platform-tools" "system-images;android-35;google_apis_playstore;x86_64"
avdmanager create avd -n fold -k "system-images;android-35;google_apis_playstore;x86_64" -d pixel_fold   # or "resizable"
emulator -avd fold -no-window -gpu swiftshader_indirect -no-audio &
adb wait-for-device
adb reverse tcp:7317 tcp:7317                            # device localhost:7317 -> this server
adb shell am start -a android.intent.action.VIEW -d http://localhost:7317 com.android.chrome
adb forward tcp:9222 localabstract:chrome_devtools_remote  # CDP at http://localhost:9222
adb emu fold; sleep 1; adb emu unfold                    # posture change with the page open
adb emu posture 2                                        # postures 1-3 on Pixel Fold / Resizable
adb shell wm density 420                                 # rough stand-in for One UI screen zoom
```

- Playwright: `_android.connect()` then `device.launchBrowser()`. Needs "Enable command line on non-rooted devices" in `chrome://flags`.
- Samsung published Fold8 / Fold8 Ultra / Flip8 emulator skins on 2026-09-24 (free Samsung login to download). They change only the appearance: stock Android, no One UI.
- Exact Fold8 display regions can be set through the AVD's `config.ini` hinge and display keys.
- *Unverified*: whether `adb emu fold` works with `-no-window`, and whether `wm size` overrides behave on foldable profiles. Try these first.

## Recipe: Samsung Remote Test Lab

1. Sign in with a free Samsung account and start a Galaxy Z Fold8 session.
2. Publish the app with Funnel (above) and open the `ts.net` URL in Chrome and Samsung Internet.
3. Optional: right-click the device screen → Test → Remote Debug Bridge for an adb connection, then use `chrome://inspect` on the desktop. Whether `adb reverse` works over it is *unverified*; if it does, Funnel is not needed.
4. Record `devicePixelRatio`, `innerWidth`/`innerHeight` folded and unfolded, and at each One UI screen zoom step, then update the Screens table.

## Sources

- Screens: [Samsung Galaxy Emulator Skin (Galaxy Z)](https://developer.samsung.com/galaxy-emulator-skin/galaxy-z.html), [skin guide](https://developer.samsung.com/galaxy-emulator-skin/guide.html), [GSMArena Fold8 display tests](https://www.gsmarena.com/samsung_galaxy_z_fold8-review-2984p3.php), [GSMArena Fold8 Ultra specs](https://www.gsmarena.com/samsung_galaxy_z_fold8_ultra_5g-14802.php), [Wikipedia: Galaxy Z Fold 8](https://en.wikipedia.org/wiki/Samsung_Galaxy_Z_Fold_8)
- DPR: [1440px: Fold6](https://1440px.com/screen-sizes/samsung-galaxy-z-fold-6/), [yesviz: Fold7](https://yesviz.com/devices/samsung-z-fold7/), [phone-simulator: Fold8](https://phone-simulator.com/devices/samsung-galaxy-z-fold-8)
- Remote Test Lab: [landing](https://developer.samsung.com/remote-test-lab), [getting started](https://developer.samsung.com/sdp/blog/en-us/2021/02/18/get-started-with-remote-test-lab-for-mobile-app-testing), [Remote Debug Bridge](https://developer.samsung.com/remote-test-lab/blog/en/2022/07/13/connect-to-devices-on-remote-test-lab-using-rdb-in-android-studio)
- Cloud farms: [TestMu AI Fold8](https://www.testmuai.com/blog/samsung-galaxy-z-fold8-real-device-cloud/), [TestMu AI pricing](https://www.testmuai.com/pricing/), [pricing summary](https://bug0.com/knowledge-base/testmu-ai-pricing), [BrowserStack devices](https://www.browserstack.com/list-of-browsers-and-platforms/live), [BrowserStack foldables](https://www.browserstack.com/docs/live/get-started/foldable-devices), [BrowserStack pricing](https://www.browserstack.com/pricing), [Device Streaming](https://developer.android.com/studio/run/android-device-streaming), [Partner Device Labs](https://android-developers.googleblog.com/2025/08/test-with-android-device-streaming-now-with-android-partner-device-labs.html?m=1), [Firebase quotas](https://firebase.google.com/docs/test-lab/usage-quotas-pricing)
- Emulator: [release notes](https://developer.android.com/studio/releases/emulator), [adaptive emulator (2026-08)](https://android-developers.googleblog.com/2026/08/emulator-adaptive.html), [command line](https://developer.android.com/studio/run/emulator-commandline), [foldable config.ini sample](https://gist.github.com/mhazard31/edc85a46746795c38985440812b4b508), [Playwright Android](https://playwright.dev/docs/api/class-android), [Sammyfans on Fold8 skins](https://www.sammyfans.com/2026/09/25/your-galaxy-fold-8-apps-are-getting-some-extra-attention/)
- Access: [Tailscale Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel), [MDN: installable PWAs](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), [Chrome port forwarding](https://developer.chrome.com/docs/devtools/remote-debugging/local-server), [Chrome DevTools device mode](https://developer.chrome.com/docs/devtools/device-mode)
