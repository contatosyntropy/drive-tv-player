# Drive TV Player — teste experimental de conversão na TV

O pacote webOS mantém a biblioteca do Google Drive e acrescenta um teste experimental de conversão local para arquivos MKV.

## O que esta versão tenta fazer

- O catálogo e os arquivos continuam no Google Drive.
- Ao selecionar um MKV no aplicativo instalado na TV, o app carrega FFmpeg.wasm e executa o FFmpeg em um Web Worker no próprio hardware da LG.
- O arquivo de entrada é registrado como arquivo remoto preguiçoso do Emscripten (`FS.createLazyFile`). A intenção é que o FFmpeg leia partes do MKV por HTTP Range, sem baixar o arquivo inteiro antes de começar.
- O vídeo é copiado sem recodificação e o áudio é convertido para AAC, gerando segmentos HLS para o player HTML5 da TV.
- A legenda SRT/VTT correspondente é carregada como faixa de legenda do vídeo.

## Limitação desta primeira prova

Esta compilação gera apenas os **primeiros 120 segundos** do episódio. É um teste de viabilidade do FFmpeg.wasm, da leitura HTTP Range no Worker e da reprodução HLS na webOS 6. Ainda não é a solução de episódio completo: os segmentos gerados ficam temporariamente na memória do aplicativo. Converter um episódio inteiro de vários GB dessa forma pode exceder a memória disponível. A próxima etapa depende de confirmar na TV se o FFmpeg.wasm inicia, se o acesso por partes funciona e se a TV reproduz o HLS gerado.

O teste usa FFmpeg.wasm e hls.js hospedados em CDN; portanto, a TV precisa estar conectada à internet. O primeiro carregamento do motor pode demorar.

## Instalação

O workflow `.github/workflows/build-webos.yml` empacota o aplicativo e publica o arquivo `.ipk` como artefato do GitHub Actions. Baixe o artefato `drive-tv-player-webos-ipk` da execução mais recente.

## Observação

Este é um aplicativo webOS empacotado, não um binário C/C++ nativo. O SDK oficial da LG empacota aplicativos web; o desenvolvimento nativo para TVs LG exige ferramentas não oficiais e não foi introduzido nesta versão.
