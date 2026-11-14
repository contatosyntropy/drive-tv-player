# Drive TV Player — aplicativo webOS

Esta pasta contém os metadados e a página de entrada do pacote instalável para TVs LG.

O workflow em `.github/workflows/build-webos.yml` monta os arquivos atuais do player, gera o ícone PNG e empacota um arquivo `.ipk` usando o CLI oficial da LG.

## Importante sobre a reprodução

Este primeiro pacote é um aplicativo webOS empacotado. Ele mantém a interface e o player HTML5 existentes, mas executa no mecanismo web da TV. A instalação como `.ipk` não habilita automaticamente codecs que o mecanismo não suporta nem dá acesso ao reprodutor USB interno.

A versão aponta os endpoints de mídia para o Worker já publicado. O catálogo continua vindo do Google Drive. O objetivo inicial é validar a instalação, navegação por controle remoto, acesso ao Drive e comportamento real de reprodução na TV antes de qualquer migração definitiva.

O arquivo `config.js` é copiado durante o build, sem ser duplicado no repositório dentro desta pasta. Ele contém a configuração já usada pelo site; mantenha a chave da API restrita no Google Cloud.
