import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

// Chave de publicação (veja key.properties.exemplo). Fora do repositório, como manda a boa prática.
val chaveArquivo = rootProject.file("key.properties")
val chave = Properties().apply { if (chaveArquivo.exists()) load(chaveArquivo.inputStream()) }
val temChave = chaveArquivo.exists() && chave.getProperty("storeFile") != null

android {
  namespace = "br.com.playtechvip.app"
  compileSdk = 36

  defaultConfig {
    applicationId = "br.com.playtechvip.app"
    minSdk = 23          // alcança TVs TCL/Android TV antigas
    targetSdk = 35   // a Play exige 34+ para Android TV; 35 é o degrau estável para TV
    versionCode = 1
    versionName = "1.0.0"
  }

  signingConfigs {
    create("publicacao") {
      if (temChave) {
        storeFile = file(chave.getProperty("storeFile"))
        storePassword = chave.getProperty("storePassword")
        keyAlias = chave.getProperty("keyAlias")
        keyPassword = chave.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = if (temChave) signingConfigs.getByName("publicacao") else signingConfigs.getByName("debug")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}

dependencies {
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.webkit:webkit:1.12.1")
  // Player nativo do Android: ExoPlayer (Media3), com HLS para os canais ao vivo.
  implementation("androidx.media3:media3-exoplayer:1.4.1")
  implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
  implementation("androidx.media3:media3-ui:1.4.1")
}
