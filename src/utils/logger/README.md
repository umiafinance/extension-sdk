# Logger

Console-only, level-gated logging with redaction. Logs never leave the device:
there is no queue, storage mirror, device ID or remote destination.

```javascript
// background
import { loggingHub } from "../utils/logger/LoggingHub";
loggingHub.info("[BACKGROUND] Fetched provider", "background.provider", { payload });

// content or offscreen: relayed to the hub over LOG_MESSAGE
import { createRemoteLogger } from "../utils/logger/RemoteLogger";
createRemoteLogger("content").info("[Content] Ready", "content.init");
```

`logLevel` (default `INFO`) prints payloads redacted; `FINE` prints them raw.
`consoleEnabled` (default off) decides whether anything is printed. See the
Logging section of the package `CLAUDE.md` for the redaction rules.
