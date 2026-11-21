import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

// Chave de publicação. Fica fora do repositório: crie `key.properties` ao lado deste arquivo,
// a partir do `key.properties.exemplo`, com o caminho e as senhas do keystore de vocês.
// Sem ele, o release sai assinado com a chave de depuração — serve para testar, não para a loja.
val chaveArquivo = rootProject.file("key.properties")
val chave = Properties().apply { if (chaveArquivo.exists()) load(chaveArquivo.inputStream()) }
val temChave = chaveArquivo.exists() && chave.getProperty("storeFile") != null

android {
  namespace = "br.com.playtechvip.celular"
  compileSdk = 36

  defaultConfig {
    applicationId = "br.com.playtechvip.celular"
    minSdk = 24          // Android 7 em diante: cobre praticamente todo aparelho em uso
    targetSdk = 36       // exigido pela Google Play para app novo e para atualização
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
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.webkit:webkit:1.12.1")
  // Player nativo do Android: ExoPlayer (Media3), com HLS para os canais ao vivo.
  implementation("androidx.media3:media3-exoplayer:1.4.1")
  implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
  implementation("androidx.media3:media3-ui:1.4.1")
}
