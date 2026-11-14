# Drive TV Player

Player web simples para navegar e reproduzir vídeos de uma pasta pública do Google Drive, com interface compatível com navegação por controle remoto.

## Configuração

1. No Google Cloud Console, crie ou selecione um projeto.
2. Habilite **Google Drive API**.
3. Crie uma chave de API em **APIs e serviços → Credenciais**.
4. Restrinja a chave à Google Drive API e, depois de publicar, ao domínio do site.
5. Edite `config.js` e substitua `COLE_SUA_CHAVE_API_AQUI` pela chave.
6. Confirme que a pasta e os vídeos estão compartilhados como **Qualquer pessoa com o link – Leitor**.

A pasta configurada é a biblioteca informada no projeto.

## Publicar no Cloudflare Workers

O repositório inclui `wrangler.jsonc` e `worker.js`. O Worker entrega os arquivos estáticos e disponibiliza `/api/subtitle/{fileId}` como proxy para as legendas do Google Drive.

- Conecte o repositório ao Worker **drive-tv-player** em Workers Builds.
- Branch de produção: `main`.
- Deploy command: `npx wrangler deploy` (padrão).
- Não é necessário comando de build para este projeto estático.
- O arquivo `.assetsignore` impede que o código do Worker e a configuração sejam publicados como arquivos públicos.

O navegador continua reproduzindo os vídeos pelo método direto atual. Apenas as legendas passam pelo Worker.

## Player de vídeo

A interface de reprodução usa Video.js 8, carregado pela CDN oficial. O Video.js padroniza os controles, navegação e tratamento de fontes, mas utiliza a decodificação de mídia do navegador/webOS. Ele não instala codecs nem converte arquivos MKV/AC3. A compatibilidade de cada combinação de contêiner e codec continua dependendo da TV.

## Observações importantes

- O site lista vídeos pela Drive API, mas a reprodução usa o endpoint de download do Google Drive. O Drive não é uma plataforma de streaming: arquivos grandes, limites de cota, confirmações de download e busca dentro do vídeo podem falhar.
- Para melhor compatibilidade com TVs, prefira MP4 com vídeo H.264 e áudio AAC.
- A compatibilidade real depende do navegador webOS e precisa ser testada na TV.
- A chave da API no front-end é visível. Restrinja-a e não use credenciais OAuth ou chaves privadas neste arquivo.
- Esta versão é estática e não usa servidor próprio.
