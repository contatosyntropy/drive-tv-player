# Drive TV Player — Desktop Test Kit

Este pacote permite testar, no Windows, a entrega do vídeo pelo Worker e a leitura do contêiner/codecs com FFmpeg, sem precisar usar a TV.

## Como usar

1. Extraia o ZIP em uma pasta.
2. Execute `Run-DriveTV-Test.bat`. A janela permanecerá aberta ao final.
3. O resultado completo também será salvo em `diagnostico-drive-tv.txt`, na mesma pasta.
3. Cole a URL completa do endpoint `/api/video/{ID}/{NOME}`; ou pressione Enter e informe ID, nome do arquivo e chave da API nos campos solicitados.
4. O teste faz requisições HTTP Range em diferentes posições do arquivo.
5. O FFprobe identifica contêiner, codecs, resolução, duração e áudio.
6. O FFplay abre a reprodução no PC. Feche a janela do vídeo ou pressione Esc para encerrar.

URL base padrão do Worker:

`https://drive-tv-player.contatosyntropy.workers.dev`

## O que este teste comprova

- Se o Worker aceita requisições parciais HTTP Range (206 / Content-Range).
- Se o FFmpeg consegue abrir e demultiplexar o arquivo MKV diretamente pela URL, sem baixar o arquivo inteiro antes.
- Quais codecs de vídeo e áudio estão presentes.
- Se o PC consegue decodificar e reproduzir o conteúdo.

## O que NÃO comprova

- Não emula webOS, NDL DirectMedia ou o decodificador de hardware da LG.
- A reprodução no PC usa os decodificadores disponíveis no pacote FFmpeg e no computador.
- Um arquivo funcionar no PC não garante que o firmware da TV aceite o mesmo codec ou fluxo.

## Privacidade

A chave da API é solicitada apenas durante a execução e não é gravada neste pacote. Não publique a URL completa caso ela contenha a chave.

## FFmpeg

O pacote inclui os executáveis FFmpeg, FFprobe e FFplay da distribuição Windows Essentials do Gyan.dev. Consulte os avisos de licença e a página de builds em https://www.gyan.dev/ffmpeg/builds/ antes de redistribuir o pacote.
