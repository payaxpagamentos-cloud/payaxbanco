#!/usr/bin/env bash
# Instala a transcrição de áudio da ZOE: compila o whisper.cpp, baixa o modelo em português
# e deixa o whisper-server pronto para subir. Não custa nada por áudio — roda nesta máquina.
#
#   sudo ./scripts/instalar-whisper.sh            # instala em /opt/whisper
#   sudo ./scripts/instalar-whisper.sh /outro/dir
#
# Precisa de: git, cmake, g++, make e ffmpeg (o ffmpeg converte o áudio do WhatsApp).
# O modelo "small" tem ~490 MB e usa ~1 GB de RAM com o servidor no ar.
set -euo pipefail

DESTINO="${1:-/opt/whisper}"
MODELO="${WHISPER_MODELO:-small}"
NUCLEOS="$(nproc 2>/dev/null || echo 4)"

for prog in git cmake g++ make ffmpeg ffprobe curl; do
  command -v "$prog" >/dev/null || { echo "Falta instalar: $prog (ex.: apt-get install -y $prog)"; exit 1; }
done

mkdir -p "$DESTINO"
cd "$DESTINO"

if [ ! -d src ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git src
fi
cmake -S src -B src/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF >/dev/null
cmake --build src/build -j "$NUCLEOS" --config Release >/dev/null

if [ ! -s "ggml-$MODELO.bin" ]; then
  curl -fSL -o "ggml-$MODELO.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODELO.bin"
fi

cat <<FIM

Pronto. Para deixar o servidor do whisper no ar (recomendado: o modelo fica carregado):

  $DESTINO/src/build/bin/whisper-server -m $DESTINO/ggml-$MODELO.bin -l pt -t $NUCLEOS --host 127.0.0.1 --port 8178

E no ambiente do ZOE Atende:

  ATEND_WHISPER_URL=http://127.0.0.1:8178

Ou, sem servidor (mais simples, ~1,5 s mais lento por áudio):

  ATEND_WHISPER_BIN=$DESTINO/src/build/bin/whisper-cli
  ATEND_WHISPER_MODELO=$DESTINO/ggml-$MODELO.bin
FIM
