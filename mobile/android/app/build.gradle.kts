plugins { id("com.android.application") }
android {
 namespace = "dev.termweave.companion"
 compileSdk = 35
 defaultConfig { applicationId = "dev.termweave.companion"; minSdk = 29; targetSdk = 35; versionCode = 1; versionName = "0.1.0-pilot" }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
dependencies { implementation("com.squareup.okhttp3:okhttp:4.12.0") }
