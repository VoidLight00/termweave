plugins { id("com.android.application") }
// The app version follows the TermWeave release, so every release is an installable update (x.y.z -> x*10000+y*100+z).
val termweaveVersion = Regex("\"version\":\\s*\"([0-9]+)\\.([0-9]+)\\.([0-9]+)\"").find(rootProject.file("../../package.json").readText())!!.groupValues
val termweaveVersionCode = termweaveVersion[1].toInt() * 10000 + termweaveVersion[2].toInt() * 100 + termweaveVersion[3].toInt()
android {
 namespace = "dev.termweave.companion"
 compileSdk = 35
 defaultConfig { applicationId = "dev.termweave.companion"; minSdk = 29; targetSdk = 35; versionCode = termweaveVersionCode; versionName = "${termweaveVersion[1]}.${termweaveVersion[2]}.${termweaveVersion[3]}" }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
dependencies { implementation("com.squareup.okhttp3:okhttp:4.12.0") }
