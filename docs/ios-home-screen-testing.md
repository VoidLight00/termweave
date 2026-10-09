# iOS home-screen header checks

[PR #199](https://github.com/devswha/herdr-web-ui/pull/199) addresses
[#164](https://github.com/devswha/herdr-web-ui/issues/164) by removing
`apple-mobile-web-app-status-bar-style="black-translucent"`. The candidate leaves
the metadata **absent**; it does not set an explicit `default` value. Apple's
[archived reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)
describes the default layout as placing content below the status bar. That
reference does not establish blur behavior or safe-area dimensions on every iOS
build. This change keeps the shell, sticky header, viewport code and safe-area
padding.

## Evidence and limits

- The original [iPhone report](https://github.com/devswha/herdr-web-ui/issues/164#issuecomment-5905630127)
  on iOS 27.0 (24A437) found that #178's fixed-shell workaround did not remove
  portrait blur. Landscape was already sharp. Its separate ruler page improved
  with explicit `default`; that was not a test of this candidate app.
- A second [physical-iPhone report](https://github.com/devswha/herdr-web-ui/issues/164#issuecomment-5909282333)
  identifies iOS 27.0.0, without a model or build number. It reports blur in both
  themes for a fresh main 0.3.34 install with `black-translucent`, and sharp text
  and a legible clock in both themes after re-adding the #199 variant. The PR
  describes that variant as omitted metadata. The report does not establish
  keyboard behavior, safe-area values or data retention.
- Independent owned Simulator checks use Xcode 27.0 (27A266a), iPhone 17 Pro,
  iOS 27.0 (24A434). An earlier `black-translucent` setup reproduced portrait
  blur, with a 62 CSS px top safe area and 114 CSS px header. The explicit
  `default` reference install was launched from the Home Screen and reported
  `navigator.standalone === true`: portrait header/clock were sharp, top safe
  area 0, bottom 34, header 52 CSS px. Rotation, background/reopen and drawer
  checks passed for that reference. Its software-keyboard visibility remains
  unverified: finding off-screen accessibility keys does not prove it is shown.

- Combined #199/#186 acceptance, 2026-09-30: Xcode 27.0 (27A266a), iPhone 17 Pro
  Simulator, iOS 27.0 (24A434), main `da484de` merged with #186 `8bf88fc` and
  #199 `ce0f2bf`, fresh **Add to Home Screen** install on a test herdr session. With
  hardware-keyboard simulation off (DeviceHub setting *Always simulate hardware keyboard*;
  `defaults write com.apple.dt.Devices alwaysSimulateHardwareKeyboard -bool false`, then
  reboot the device), the software keyboard was visible. Header text and clock stayed sharp
  in portrait idle, composer focus with the keyboard open, typing, dismissal with Done,
  xterm direct typing, drawer open/close and relaunch. The composer and key bar sat directly
  above the keyboard's accessory bar and returned to the bottom edge, without a gap, after
  dismissal. Dark theme only; rotation and data lifecycle were not re-run here.

The independent `default` result is a separate control, not an exact-source
test of #199's absent metadata. Do not infer a universal zero top inset, a fixed
blur-band height, or success on all iOS 26 and later builds. Record the exact
served source and build for future captures; the earlier baseline's served
application commit/build is not identified here. Its OS build is 24A434.
Desktop and Safari-tab tests do not validate installed-app
native blur.

## Native comparison matrix

Use isolated origins and fictional or owned test sessions. Install from Safari
with **Add to Home Screen**, keeping **Open as Web App** on. Record source commit,
clean/dirty source state, build time, origin, install history, runtime/build,
`navigator.standalone`, and the metadata actually present in the installed app.
Build each source explicitly and verify the served HTML/assets; a checkout's
HEAD alone does not identify an already-running server or cached install.

| Variant | Status-bar metadata | Viewport code | Remaining checks |
| --- | --- | --- | --- |
| New baseline comparison | `black-translucent` | main `66328ef` | Capture this exact built source |
| Independent control | explicit `default` | owned reference source | Visible software keyboard; data lifecycle |
| #199 candidate | absent | candidate integrated with `66328ef` | Exact-source native comparison and acceptance |
| Composer-gap comparison | `black-translucent` | #186 | Test separately from the metadata change |
| Combined comparison | absent | #186 | Required for combined #199/#186 acceptance; implementations remain separate |

For dark and light themes, capture portrait idle, visibly open software keyboard,
composer typing and dismissal, xterm direct typing, landscape and return to
portrait, background/reopen, and drawer open/close. Record `innerHeight`,
`visualViewport.height`/`offsetTop`, top/bottom safe-area values, `--app-height`,
`data-keyboard`, and app/header/composer/key-bar rectangles. Check header and
clock readability, composer/key-bar/drawer fit, bottom gaps and horizontal page
scroll. A Safari-tab or an off-screen keyboard node is not a completed check.

[WebKit #316008](https://bugs.webkit.org/show_bug.cgi?id=316008) reports
`100vh`/`100lvh` overflow for omitted-metadata standalone installs on Safari 26,
with install-time behavior persisting after a metadata update. Earlier versions
were not tested by that reporter. Treat this as a compatibility risk to check,
not a confirmed herdr regression. iOS 26.5 (23F77) Simulator coverage is pending.

## Existing-install and data preservation checks

Keep the existing user install intact. Run lifecycle comparisons in an owned,
disposable install at the same test origin: first install `black-translucent`,
seed the states below, record/export them, update to absent metadata, and reopen
without removal. Compare a separate fresh install. A removal/re-add comparison
belongs only to that disposable QA install after its saved data has been checked.
Do not clear user website data, erase a Simulator, revoke real pairings or reset
server credentials/push keys as a workaround.

| State | Storage/recovery boundary | Owned QA check before and after each transition |
| --- | --- | --- |
| Composer draft | Browser local storage, per PC/pane | Save fictional unsent text separately; compare text after reopen/export recovery |
| Terminal disconnected draft | Browser local storage, text and dropped-special count | Copy text and record the count; verify both without sending input |
| Held message queue | Browser local storage, per PC/pane | Save every item, ID and order; verify that nothing sends automatically |
| Settings and UI preferences | Browser local storage | Record theme, density, fonts, replies, alert preferences and selected target/view; compare values |
| Pairing/authentication | HttpOnly cookies plus server device records | Keep the QA server state unchanged; check access/role before and after; record whether fresh pairing is needed |
| Notifications | OS permission, service-worker subscription and server registration | Record permission and subscription presence; verify with an owned test device/fake endpoint; note any permission or registration step needed |

For developer QA, privately capture only the test origin's `herdr-web-ui:*`
local-storage records, together with the origin and PC/pane identifiers, and
verify recovery in an owned fixture before any disposable-install removal.
Composer/queue records are handled by `src/lib/composerDraft.ts` and
`src/lib/messageQueue.ts`; settings by `src/lib/settings.ts`. A local-storage
capture does not export HttpOnly credentials, notification permission or a push
subscription. It also cannot recover in-memory-only text after a storage write
failure, pending sends or unsaved attachments. Copy unsent text separately and
settle pending sends before a lifecycle comparison. Never post credential or
push-subscription contents in evidence.

There is no automatic migration/export added by this PR. Browser storage
retention across removal/re-add, pairing continuity and notification continuity
remain unverified on the target iOS installations. Record retained/lost/recovered
results separately from header appearance, and keep the candidate draft until
the exact-source native, viewport and preservation checks are accepted.
