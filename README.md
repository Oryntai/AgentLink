# AgentLink

Минимальный зашифрованный мост между двумя локальными Codex/Claude-сессиями. Модели работают через подписки своих владельцев; AgentLink не вызывает model API и не получает доступ к чужим файлам, терминалу или БД.

## Что уже работает

- E2E-зашифрованная передача через WebSocket relay.
- `peer_exchange`: отправить реплику и приостановить текущий Codex turn до ответа.
- Claude Code channel: входящее сообщение само будит idle/background-сессию.
- Обязательное согласование цели и взаимное завершение.
- Очередь при потере связи и доставка после переподключения.
- Локальный расшифрованный JSONL-журнал; relay хранит только ciphertext.

## Первый локальный тест

Требуется Node.js 20+.

```powershell
cd D:\AgentLink
npm install
./scripts/start-relay.ps1
```

Во втором терминале создать конфигурацию Codex:

```powershell
npm run create-room -- --agent oryntai-codex --name "Oryntai Codex" --relay ws://127.0.0.1:8787/ws
```

Команда напечатает секретный `ROOM_CODE`. Создать конфигурацию Claude с этим кодом:

```powershell
npm run join-room -- --code "ROOM_CODE" --agent oryntai-claude --name "Oryntai Claude" --relay ws://127.0.0.1:8787/ws --channel
```

Установить MCP в клиенты, используя пути, напечатанные командами:

```powershell
node scripts/install-mcp.js --config "D:\AgentLink\.agent-link\oryntai-codex.json" --client codex
node scripts/install-mcp.js --config "D:\AgentLink\.agent-link\oryntai-claude.json" --client claude
node scripts/install-mcp.js --config "D:\AgentLink\.agent-link\oryntai-claude.json" --client claude-desktop
```

После установки полностью перезапустить Codex Desktop и Claude Desktop. В Claude Desktop используется блокирующий `peer_exchange`. Для настоящего push/background channel в Claude Code research preview:

```powershell
claude --dangerously-load-development-channels server:agent-link
```

## Промпты для теста

Codex, инициатор:

```text
Используй AgentLink. Проверь peer_status, предложи агенту конечную цель разговора через peer_goal и дождись подтверждения. Затем обсуждай задачу через peer_exchange как по рации. Локально разрешены только read-операции. Когда критерии цели достигнуты, предложи взаимное завершение через peer_complete. Не заканчивай текущую задачу, пока разговор не завершён или человек не остановил его.
```

Claude, responder/channel:

```text
Используй AgentLink как background channel. Проверь peer_status и оставайся доступным для входящих channel-сообщений. Подтверди или отклони предложенную цель через peer_goal. Отвечай агенту через peer_reply. Выполняй только локальные read-операции и никогда не отправляй секреты. Когда peer предложит завершение, проверь критерии и ответь через peer_complete.
```

## Другая машина

Друг клонирует этот репозиторий, выполняет `npm install`, получает `ROOM_CODE` приватно и запускает `join-room` со своим публично доступным relay URL.

Проще всего для первого удалённого теста соединить машины через Tailscale и передать адрес вида:

```text
ws://100.x.y.z:8787/ws
```

На машине с relay нужно задать `AGENT_LINK_HOST=0.0.0.0`. Для постоянного публичного сервера используйте TLS (`wss://`) за reverse proxy.

## Журналы

Логи находятся рядом с локальной конфигурацией:

```text
D:\AgentLink\.agent-link\logs\<agent>\<room>-<agent>.jsonl
```

Собрать читаемый отчёт:

```powershell
npm run report -- --config "D:\AgentLink\.agent-link\oryntai-codex.json"
```

Отчёт появится в `.agent-link\reports`. Секрет комнаты в логи не записывается.

Остановить локальный relay:

```powershell
./scripts/stop-relay.ps1
```

## Проверка

```powershell
npm run smoke
```

Тест проверяет шифрование, одновременный обмен, offline-очередь, переподключение, MCP STDIO, блокирующий Codex exchange, Claude push channel, цель и взаимное завершение.
