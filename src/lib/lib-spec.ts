/**
 * lib v1 — canonical TypeScript contract
 *
 * 11 must-have фич (Tier 1-3) + 1 optional helper.
 * Реализация — в lib-*.ts файлах. Этот файл — только типы.
 *
 * См. /workspace/mcp-knowledge/lib-docs/final-matrix.md
 */

// ============================================================================
// Tier 1 — обязательный контракт (host-facing)
// ============================================================================

/** `transport-stdio` — host→MCP transport. JSON-RPC по stdin/stdout. */
export interface StdioTransport {
  /** MCP-протокол версия (текущая: 2025-06-18) */
  readonly protocolVersion: string;
  /** Имя сервера (например "dsh-cli-mcp") */
  readonly serverName: string;
  /** Версия сервера (semver) */
  readonly serverVersion: string;
  /** Запустить серверный loop, слушать stdin */
  start(): Promise<void>;
  /** Остановить сервер, закрыть stdin */
  stop(): Promise<void>;
}

/** Метаданные persistent сессии. */
export interface SessionInfo {
  /** Уникальный ID (UUID v4 или короткий 8-char) */
  readonly id: string;
  /** Когда создана (ISO 8601) */
  readonly createdAt: string;
  /** Когда последний раз использовалась */
  readonly lastUsedAt: string;
  /** Working directory на момент создания */
  readonly cwd: string;
  /** ID модели, если зафиксирована */
  readonly modelId?: string;
  /** Краткое summary первого user-prompt (≤120 chars) */
  readonly summary: string;
  /** Кол-во сообщений */
  readonly messageCount: number;
}

/** `session-list` — список persistent сессий. */
export interface SessionListFeature {
  /**
   * @returns массив сессий, отсортированный по lastUsedAt desc
   */
  listSessions(): Promise<SessionInfo[]>;
}

/** `session-resume` — продолжить сессию по ID. */
export interface SessionResumeFeature {
  /**
   * @param sessionId — ID существующей сессии
   * @param prompt — новый user-prompt, который будет добавлен в контекст
   * @returns результат прогона модели (ассистентский ответ)
   */
  resumeSession(sessionId: string, prompt: string): Promise<string>;
}

/** Метаданные модели, которую умеет вызывать wrapped CLI. */
export interface ModelInfo {
  /** ID модели (например "deepseek-chat", "deepseek-coder") */
  readonly id: string;
  /** Человекочитаемое имя */
  readonly displayName: string;
  /** Провайдер ("deepseek", "openai", ...) */
  readonly provider: string;
  /** Контекст-окно в токенах */
  readonly contextWindow: number;
  /** Поддерживает ли tool-calling */
  readonly supportsTools: boolean;
  /** Поддерживает ли vision */
  readonly supportsVision: boolean;
}

/** `discovery-model-list` — какие модели доступны. */
export interface DiscoveryModelListFeature {
  /**
   * @returns массив моделей. Может быть пустым если CLI не поддерживает list.
   */
  listModels(): Promise<ModelInfo[]>;
}

// ============================================================================
// Tier 2 — общие паттерны
// ============================================================================

/** `cancellation` — transport-level JSON-RPC cancel + signal-fallback. */
export interface CancellationFeature {
  /**
   * Зарегистрировать AbortController для текущего tool-call.
   * При host-отмене будет вызван abort controller.
   */
  setupCancellation(): AbortController;
  /**
   * Корректно остановить CLI процесс: SIGTERM → wait 5s → SIGKILL.
   * @param pid — process ID CLI
   */
  terminateProcess(pid: number): Promise<void>;
}

/** Событие сессии для live-replay. */
export type SessionEvent =
  | { type: "user-prompt"; content: string; at: string }
  | { type: "assistant-text"; content: string; at: string }
  | { type: "tool-call"; name: string; args: unknown; at: string }
  | { type: "tool-result"; name: string; result: unknown; at: string }
  | { type: "error"; message: string; at: string }
  | { type: "session-end"; reason: "completed" | "killed" | "errored"; at: string };

/** `observability-session-replay` — live replay событий. */
export interface ObservabilitySessionReplayFeature {
  /**
   * Подписаться на события сессии. Возвращает unsubscribe функцию.
   * @param sessionId — какую сессию слушать
   * @param onEvent — callback, вызывается для каждого события
   */
  subscribe(sessionId: string, onEvent: (event: SessionEvent) => void): () => void;
}

// ============================================================================
// Tier 3 — strong picks
// ============================================================================

/** `session-kill` — убить долгоживущий сеанс. */
export interface SessionKillFeature {
  /**
   * Принудительно остановить сессию. Закрыть process group,
   * удалить state-file.
   * @param sessionId — какую сессию убить
   */
  killSession(sessionId: string): Promise<void>;
}

/** `mid-run-abort` — прервать активный прогон, сессию сохранить. */
export interface MidRunAbortFeature {
  /**
   * Послать в CLI команду abort текущего прогона.
   * Модель прекратит работу, но сессия останется живой.
   * @param sessionId — сессия с активным прогоном
   */
  abortRun(sessionId: string): Promise<void>;
}

/** `mid-run-steer` — прервать + дать новый промпт. */
export interface MidRunSteerFeature {
  /**
   * Прервать текущий прогон и поставить новый промпт в очередь.
   * Атомарная операция: abort + push.
   * @param sessionId — сессия
   * @param newPrompt — новый промпт
   */
  steerRun(sessionId: string, newPrompt: string): Promise<void>;
}

/** `sub-transport-acp` — двунаправленный протокол к wrapped CLI. */
export interface SubTransportAcp {
  /** Имя транспорта */
  readonly name: "acp" | "print" | "rpc";
  /**
   * Отправить запрос в CLI и получить ответ (event stream).
   * @param request — JSON-RPC-like payload
   * @returns async iterable событий
   */
  send(request: AcpRequest): AsyncIterable<AcpEvent>;
}

export interface AcpRequest {
  /** Метод (например "run", "abort", "list-sessions") */
  method: string;
  /** Параметры */
  params: Record<string, unknown>;
}

export interface AcpEvent {
  /** Тип события */
  type: "init" | "message" | "tool-call" | "tool-result" | "done" | "error";
  /** Payload, зависит от type */
  payload: unknown;
}

/** `approval-mode` — политика одобрения tool-вызовов. */
export type ApprovalMode = "yolo" | "default" | "auto" | "plan";

export interface ApprovalModeFeature {
  /**
   * Получить текущий режим approval.
   */
  getApprovalMode(): ApprovalMode;
  /**
   * Установить режим approval для последующих прогонов.
   * @param mode — один из 4 валидных значений
   */
  setApprovalMode(mode: ApprovalMode): void;
}

/** `session-export` — snapshot сессии в файл. */
export interface SessionExportFeature {
  /**
   * Экспортировать сессию в JSON-файл.
   * @param sessionId — какую сессию
   * @param targetPath — куда сохранить (абсолютный путь)
   */
  exportSession(sessionId: string, targetPath: string): Promise<void>;
}

// ============================================================================
// Optional helper
// ============================================================================

/** `discovery-tool-list` — обёртка над MCP tools/list (опционально). */
export interface DiscoveryToolListFeature {
  /**
   * Получить список экспортируемых tools с типизированными схемами.
   * По сути это typed wrapper над MCP-обязательным tools/list.
   */
  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

// ============================================================================
// Аггрегатор — общий интерфейс lib
// ============================================================================

/** Полный набор фич lib v1. Реализация может не реализовывать все. */
export interface LibV1
  extends StdioTransport,
    SessionListFeature,
    SessionResumeFeature,
    DiscoveryModelListFeature,
    CancellationFeature,
    ObservabilitySessionReplayFeature,
    SessionKillFeature,
    MidRunAbortFeature,
    MidRunSteerFeature,
    SubTransportAcp,
    ApprovalModeFeature,
    SessionExportFeature,
    DiscoveryToolListFeature {}

// ============================================================================
// Внутренние типы — для реализации lib
// ============================================================================

/** Конфиг lib (читается из env или передан явно). */
export interface LibConfig {
  /** Имя CLI-бинаря (например "dsh") */
  readonly cliBinary: string;
  /** Аргументы по умолчанию (например ["--print"]) */
  readonly defaultArgs: readonly string[];
  /** Default sub-transport */
  readonly defaultTransport: "acp" | "print" | "rpc";
  /** Env-var override для transport (например "DSH_MCP_TRANSPORT") */
  readonly transportEnvVar: string;
  /** Где хранить state-файлы сессий */
  readonly stateDir: string;
  /** Env-var override для самого бинаря (например "DSH_BINARY" или legacy "DSH_MCP_BIN") */
  readonly binaryEnvVar: string;
  /** Макс. concurrent прогонов (slot-semaphore) */
  readonly maxConcurrent: number;
  /** Default approval mode */
  readonly defaultApprovalMode: ApprovalMode;
  /** Per-call timeout (ms) */
  readonly callTimeoutMs: number;
  /** Server default timeout (ms) */
  readonly serverTimeoutMs: number;
  /** Макс. размер output в памяти (bytes) */
  readonly maxOutputBytes: number;
  /** Allow list моделей (если пусто — все из list-models) */
  readonly allowedModels: ReadonlySet<string>;
}
