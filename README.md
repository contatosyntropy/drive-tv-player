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

## Publicar no Cloudflare Pages

- Importe este repositório no Cloudflare Pages.
- Framework preset: **None**.
- Build command: deixe vazio.
- Build output directory: `/`.
- Salve e aguarde o deploy.

## Observações importantes

- O site lista vídeos pela Drive API, mas a reprodução usa o endpoint de download do Google Drive. O Drive não é uma plataforma de streaming: arquivos grandes, limites de cota, confirmações de download e busca dentro do vídeo podem falhar.
- Para melhor compatibilidade com TVs, prefira MP4 com vídeo H.264 e áudio AAC.
- A compatibilidade real depende do navegador webOS e precisa ser testada na TV.
- A chave da API no front-end é visível. Restrinja-a e não use credenciais OAuth ou chaves privadas neste arquivo.
- Esta versão é estática e não usa servidor próprio.
