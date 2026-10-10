plugins { id("com.android.application") }
// The app version follows the TermWeave release, so every release is an installable update (x.y.z -> x*1000000+y*1000+z).
// auto_release bumps the patch on every feat/fix commit: 1000 patch slots keep 0.3.100 below 0.4.0.
val termweaveVersion = Regex("\"version\":\\s*\"([0-9]+)\\.([0-9]+)\\.([0-9]+)\"").find(rootProject.file("../../package.json").readText())!!.groupValues
val termweaveVersionCode = termweaveVersion.let { (_, major, minor, patch) ->
    require(minor.toInt() < 1000 && patch.toInt() < 1000) { "minor and patch must stay below 1000 for versionCode ordering" }
    major.toInt() * 1000000 + minor.toInt() * 1000 + patch.toInt()
}
android {
 namespace = "dev.termweave.companion"
 compileSdk = 35
 defaultConfig { applicationId = "dev.termweave.companion"; minSdk = 29; targetSdk = 35; versionCode = termweaveVersionCode; versionName = "${termweaveVersion[1]}.${termweaveVersion[2]}.${termweaveVersion[3]}" }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
dependencies { implementation("com.squareup.okhttp3:okhttp:4.12.0") }
