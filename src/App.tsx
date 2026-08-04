import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  cancelMatch,
  createChallenge,
  createMatch,
  createTeamPreset,
  deleteAccount,
  deleteTeamPreset,
  getAccounts,
  getMatches,
  getObservedQuestions,
  getTtmcCatalog,
  getTeamPresets,
  quoteMatch,
  reauthenticateAccount,
  refreshAccount,
  resumeMatch,
  updateTeamPreset,
  verifyChallenge,
  ApiError,
  type Account,
  type Challenge,
  type GameMode,
  type LiveGame,
  type LiveMatch,
  type LivePlayer,
  type LiveScore,
  type Match,
  type MatchQuote,
  type MatchSetup,
  type MatchTeam,
  type ObservedQuestion,
  type TtmcCatalog,
  type TeamPreset,
  type TtmcAnswer,
  type TtmcGame,
  type TtmcQuestion,
} from "./api";
import "./App.css";

type Tab = "play" | "match" | "history" | "settings";
type Side = "a" | "b";
type ContentSlug = "all" | "300" | "299" | "geographie" | "sciences";
type TtmcSelection = { slugs: string[]; all: boolean };
type Draft = {
  host: Side;
  accountIds: Record<Side, string>;
  teams: Record<Side, { name: string; roster: string[] }>;
  contentSlug: ContentSlug;
  durationMinutes: number;
  gameMode: GameMode;
  rounds: number;
  ttmcSelections: Record<string, TtmcSelection>;
};
type RosterChange =
  | { type: "set"; index: number; value: string }
  | { type: "add" }
  | { type: "remove"; index: number };
type MatchCommand =
  | { type: "start-proximo" }
  | { type: "next-proximo"; gameId: number }
  | { type: "ready"; gameId: number }
  | {
      type: "answers";
      gameId: number;
      currentRound: number;
      answers: Partial<Record<Side, number>>;
    }
  | { type: "start-ttmc-round" }
  | {
      type: "start-ttmc-question";
      roundId: number;
      side: Side;
      difficulty: number;
    }
  | {
      type: "ttmc-answers";
      roundId: number;
      answers: Partial<Record<Side, TtmcAnswer>>;
    }
  | { type: "next-ttmc-round"; roundId: number }
  | { type: "finish" };
type SocketState = "idle" | "connecting" | "open" | "retrying";
type ActionResult = string | string[] | null;
type InFlightAction = {
  id: string;
  command: MatchCommand;
};
type TtmcCatalogResource =
  | { status: "idle" }
  | { status: "loading"; hostAccountId: string }
  | { status: "ready"; hostAccountId: string; data: TtmcCatalog }
  | { status: "error"; hostAccountId: string; message: string };
const sides: Side[] = ["a", "b"];
const draftStorageKey = "grooop-client.match-draft";
const initialDraft: Draft = {
  host: "a",
  accountIds: { a: "", b: "" },
  teams: {
    a: { name: "Team A", roster: ["Player one", "Player two"] },
    b: { name: "Team B", roster: ["Player three", "Player four"] },
  },
  contentSlug: "all",
  durationMinutes: 30,
  gameMode: "proximo",
  rounds: 5,
  ttmcSelections: {},
};
const content: ReadonlyArray<readonly [ContentSlug, string, string]> = [
  ["all", "All", "All four categories, shuffled together"],
  ["300", "300", "Movie lines & cultural classics"],
  ["299", "299", "The oddball little sister"],
  ["geographie", "Geography", "Maps, cities & landmarks"],
  ["sciences", "Sciences", "Experiments, nature & why"],
];

function isStoredDraft(value: unknown): value is Draft {
  if (!isRecord(value)) return false;
  const { accountIds, teams, ttmcSelections } = value;
  const validTeam = (team: unknown) =>
    isRecord(team) &&
    typeof team.name === "string" && team.name.length <= 40 &&
    Array.isArray(team.roster) && team.roster.length >= 1 && team.roster.length <= 12 &&
    team.roster.every((player) => typeof player === "string" && player.length <= 40);
  const validSelection = ([accountId, selection]: [string, unknown]) => {
    if (!accountId || accountId.length > 128 || !isRecord(selection) ||
      typeof selection.all !== "boolean" || !Array.isArray(selection.slugs) ||
      selection.slugs.length > 32 ||
      !selection.slugs.every((slug) => typeof slug === "string" && slug.length <= 80)) return false;
    return new Set(selection.slugs).size === selection.slugs.length;
  };
  return (
    (value.host === "a" || value.host === "b") &&
    isRecord(accountIds) &&
    typeof accountIds.a === "string" &&
    accountIds.a.length <= 128 &&
    typeof accountIds.b === "string" &&
    accountIds.b.length <= 128 &&
    isRecord(teams) &&
    validTeam(teams.a) &&
    validTeam(teams.b) &&
    content.some(([slug]) => slug === value.contentSlug) &&
    [15, 30, 45].includes(value.durationMinutes as number) &&
    (value.gameMode === "proximo" || value.gameMode === "ttmc") &&
    Number.isInteger(value.rounds) &&
    (value.rounds as number) >= 2 &&
    (value.rounds as number) <= 10 &&
    isRecord(ttmcSelections) &&
    Object.entries(ttmcSelections).every(validSelection)
  );
}

function loadStoredDraft(): Draft {
  try {
    const stored = localStorage.getItem(draftStorageKey);
    if (stored === null) return initialDraft;
    const payload: unknown = JSON.parse(stored);
    if (isStoredDraft(payload)) return payload;
    console.warn("Ignoring invalid saved match setup.");
  } catch (error) {
    console.warn("Could not load the saved match setup.", error);
  }
  return initialDraft;
}

function cleanTeam(team: Draft["teams"][Side]) {
  return {
    name: team.name.trim(),
    roster: team.roster.map((player) => player.trim()).filter(Boolean),
  };
}

function isActive(account: Account) {
  return account.status.toLowerCase() === "active";
}

function lowestBalanceSide(
  accountIds: Record<Side, string>,
  accounts: Account[],
  fallback: Side,
): Side {
  const a = accounts.find((account) => account.id === accountIds.a);
  const b = accounts.find((account) => account.id === accountIds.b);
  if (!a || !b || a.grooopies === b.grooopies) return fallback;
  return a.grooopies < b.grooopies ? "a" : "b";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isResumableMatch(match: Match) {
  return (
    !match.finishedAt &&
    ["joining", "waiting", "playing", "revealed"].includes(
      match.status.toLowerCase(),
    )
  );
}

function isCancellableMatch(match: Match) {
  return isResumableMatch(match) && match.status.toLowerCase() !== "joining";
}

function ttmcTurnOrder(roundNumber: number): [Side, Side] {
  return roundNumber % 2 === 0 ? ["b", "a"] : ["a", "b"];
}

function activeTtmcSide(game: TtmcGame): Side | null {
  if (game.state !== "running") return null;
  return (
    ttmcTurnOrder(game.roundNumber).find(
      (side) => !game.teams[side].submitted,
    ) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isGameId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRound(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMatchTeam(value: unknown): value is MatchTeam {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.accountId === "string" &&
    Array.isArray(value.roster) &&
    value.roster.every((player) => typeof player === "string")
  );
}

function isLivePlayer(value: unknown): value is LivePlayer {
  return (
    isRecord(value) &&
    isNullableNumber(value.id) &&
    typeof value.isConnected === "boolean" &&
    typeof value.isGameMaster === "boolean" &&
    isNullableNumber(value.score)
  );
}

function isLiveScore(value: unknown): value is LiveScore {
  return (
    isRecord(value) &&
    isNullableNumber(value.id) &&
    typeof value.isReady === "boolean" &&
    isNullableNumber(value.answer) &&
    isNullableNumber(value.delta) &&
    typeof value.submitted === "boolean"
  );
}

function isLiveGame(value: unknown): value is LiveGame {
  return (
    isRecord(value) &&
    isGameId(value.id) &&
    (value.state === null || typeof value.state === "string") &&
    isNullableNumber(value.currentRound) &&
    isNullableNumber(value.questionDurationSeconds) &&
    isNullableNumber(value.questionDeadlineAt) &&
    (value.category === null || typeof value.category === "string") &&
    (value.question === null || typeof value.question === "string") &&
    typeof value.showAnswer === "boolean" &&
    isNullableNumber(value.answer) &&
    Array.isArray(value.scores) &&
    value.scores.every(isLiveScore)
  );
}

function isTtmcQuestion(value: unknown): value is TtmcQuestion {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.prompt !== "string"
  )
    return false;
  if (value.type === "bool" || value.type === "oneword") return true;
  if (value.type === "qcm")
    return (
      Array.isArray(value.options) &&
      value.options.every((item) => typeof item === "string") &&
      isRound(value.selectionCount) &&
      value.selectionCount > 0
    );
  if (value.type === "words")
    return (
      Array.isArray(value.candidates) &&
      value.candidates.every((item) => typeof item === "string") &&
      isRound(value.answerWordCount) &&
      value.answerWordCount > 0
    );
  if (
    value.type !== "number" ||
    typeof value.min !== "number" ||
    typeof value.max !== "number" ||
    typeof value.step !== "number"
  )
    return false;
  return (
    Number.isFinite(value.min) &&
    Number.isFinite(value.max) &&
    Number.isFinite(value.step) &&
    value.min <= value.max &&
    value.step > 0
  );
}

function isTtmcTeam(value: unknown, finished: boolean): boolean {
  return (
    isRecord(value) &&
    isNullableNumber(value.difficulty) &&
    (value.difficulty === null ||
      (isRound(value.difficulty) &&
        value.difficulty >= 1 &&
        value.difficulty <= 10)) &&
    typeof value.submitted === "boolean" &&
    (value.success === null || typeof value.success === "boolean") &&
    isNullableNumber(value.points) &&
    (value.question === null || isTtmcQuestion(value.question)) &&
    (value.officialAnswer === null ||
      typeof value.officialAnswer === "string" ||
      (Array.isArray(value.officialAnswer) &&
        value.officialAnswer.every((item) => typeof item === "string")) ||
      (isRecord(value.officialAnswer) &&
        typeof value.officialAnswer.value === "number" &&
        typeof value.officialAnswer.tolerance === "number")) &&
    (finished ||
      (value.success === null &&
        value.points === null &&
        value.officialAnswer === null))
  );
}

function isTtmcGame(value: unknown): value is TtmcGame {
  if (
    !isRecord(value) ||
    value.mode !== "ttmc" ||
    !isGameId(value.id) ||
    !isRound(value.roundNumber) ||
    !isRound(value.totalRounds) ||
    (value.state !== "running" && value.state !== "finished") ||
    (value.category !== null && typeof value.category !== "string") ||
    (value.title !== null && typeof value.title !== "string") ||
    !isRecord(value.teams)
  )
    return false;
  const finished = value.state === "finished";
  return (
    isTtmcTeam(value.teams.a, finished) && isTtmcTeam(value.teams.b, finished)
  );
}

function isLiveMatch(value: unknown): value is LiveMatch {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    isRecord(value.party) &&
    typeof value.party.state === "string" &&
    typeof value.party.playerCount === "number" &&
    Array.isArray(value.players) &&
    value.players.every(isLivePlayer) &&
    isRecord(value.teams) &&
    isMatchTeam(value.teams.a) &&
    isMatchTeam(value.teams.b) &&
    (value.gameMode === "proximo" || value.gameMode === "ttmc") &&
    (value.game === null ||
      (value.gameMode === "proximo"
        ? isLiveGame(value.game)
        : isTtmcGame(value.game))) &&
    typeof value.connected === "boolean"
  );
}

function actionResultText(result: ActionResult) {
  if (result === null) return "Action accepted.";
  if (typeof result === "string") return `Action accepted: ${result}.`;
  return `Action accepted: ${result.join(", ")}.`;
}

function ttmcAnswerValue(
  question: TtmcQuestion,
  answer: TtmcAnswer | undefined,
): TtmcAnswer | undefined {
  return answer ?? (question.type === "number" ? question.min : undefined);
}

function isCompleteTtmcAnswer(
  question: TtmcQuestion,
  value: TtmcAnswer | undefined,
) {
  if (question.type === "bool") return typeof value === "boolean";
  if (question.type === "qcm")
    return Array.isArray(value) && value.length === question.selectionCount;
  if (question.type === "words")
    return Array.isArray(value) && value.length === question.answerWordCount;
  if (question.type === "oneword")
    return typeof value === "string" && value.trim().length > 0;
  return typeof value === "number" && Number.isFinite(value);
}

function useQuestionCountdown(deadlineAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (deadlineAt === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [deadlineAt]);
  if (deadlineAt === null) return null;
  const remainingSeconds = Math.max(0, Math.ceil((deadlineAt - now) / 1_000));
  return {
    label: `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`,
    urgent: remainingSeconds <= 10,
    expired: remainingSeconds === 0,
  };
}

function useLiveMatch(
  matchId: string | null,
  onActionError: (command: MatchCommand) => void,
  onAuthoritativeState: (match: LiveMatch) => void,
) {
  const [match, setMatch] = useState<LiveMatch | null>(null);
  const [state, setState] = useState<SocketState>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [inFlight, setInFlight] = useState<InFlightAction | null>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);

  const receive = useEffectEvent(
    (socket: WebSocket, data: unknown, validState: () => void) => {
      if (socketRef.current !== socket) return;
      const breakConnection = (message: string) => {
        setMatch(null);
        setInFlight(null);
        setResult("");
        setError(message);
        socket.onmessage = null;
        socket.close();
      };
      if (typeof data !== "string") {
        breakConnection("The live match sent a binary frame; reconnecting.");
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        breakConnection("The live match sent malformed JSON; reconnecting.");
        return;
      }
      if (!isRecord(message) || typeof message.type !== "string") {
        breakConnection(
          "The live match sent an invalid message; reconnecting.",
        );
        return;
      }

      if (message.type === "state") {
        if (!isLiveMatch(message.match)) {
          breakConnection(
            "The live match state did not match the expected shape; reconnecting.",
          );
          return;
        }
        const nextMatch = message.match;
        validState();
        setMatch(nextMatch);
        onAuthoritativeState(nextMatch);
        setError("");
        return;
      }
      if (message.type === "action-result") {
        const validResult =
          message.result === null ||
          typeof message.result === "string" ||
          (Array.isArray(message.result) &&
            message.result.every((item) => typeof item === "string"));
        if (
          !validResult ||
          typeof message.actionId !== "string" ||
          message.actionId !== inFlight?.id
        ) {
          breakConnection(
            "The match returned an invalid action result; reconnecting.",
          );
          return;
        }
        setError("");
        setResult(actionResultText(message.result as ActionResult));
        setInFlight(null);
        return;
      }
      if (message.type === "action-error") {
        if (
          typeof message.actionId !== "string" ||
          message.actionId !== inFlight?.id
        ) {
          breakConnection(
            "The match returned an invalid action error; reconnecting.",
          );
          return;
        }
        setResult("");
        setError(
          typeof message.message === "string"
            ? message.message
            : typeof message.error === "string"
              ? message.error
              : "The match action was rejected.",
        );
        onActionError(inFlight.command);
        setInFlight(null);
        return;
      }
      if (message.type === "connection") {
        if (message.connected !== false) {
          breakConnection("The match sent an invalid connection update.");
          return;
        }
        setMatch((current) =>
          current ? { ...current, connected: false } : current,
        );
        setError("The upstream party connection was interrupted.");
        return;
      }
      if (message.type === "pong") return;
      if (message.type === "error") {
        setError(
          typeof message.error === "string"
            ? message.error
            : "The live match reported an error.",
        );
        return;
      }
      breakConnection(
        `The live match sent an unsupported “${message.type}” message; reconnecting.`,
      );
    },
  );

  useEffect(() => {
    setMatch(null);
    setResult("");
    setError("");
    setInFlight(null);
    setRetryAvailable(false);
  }, [matchId]);

  useEffect(() => {
    if (!matchId) {
      setState("idle");
      return;
    }

    let stopped = false;
    let retries = 0;
    let reconnectTimer: number | undefined;

    function connect() {
      if (stopped) return;
      setRetryAvailable(false);
      setState(retries ? "retrying" : "connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/matches/${encodeURIComponent(matchId!)}/socket`,
      );
      socketRef.current = socket;
      let heartbeat: number | undefined;

      socket.onopen = () => {
        if (stopped || socketRef.current !== socket) return;
        setState("open");
        setError("");
        heartbeat = window.setInterval(() => {
          if (
            socketRef.current === socket &&
            socket.readyState === WebSocket.OPEN
          )
            socket.send("ping");
        }, 20_000);
      };
      socket.onmessage = (event) =>
        receive(socket, event.data, () => {
          retries = 0;
        });
      socket.onerror = () => {
        if (!stopped && socketRef.current === socket)
          socket.close();
      };
      socket.onclose = () => {
        if (heartbeat !== undefined) window.clearInterval(heartbeat);
        if (stopped || socketRef.current !== socket) return;
        socketRef.current = null;
        setInFlight(null);
        setResult("");
        if (retries >= 6) {
          setState("idle");
          setError("The live match could not reconnect after six attempts.");
          setRetryAvailable(true);
          return;
        }
        setState("retrying");
        const delay = Math.min(1_000 * 2 ** retries, 10_000);
        retries += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
  }, [matchId, retryGeneration]);

  function send(command: MatchCommand): string | null {
    const socket = socketRef.current;
    if (
      state !== "open" ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      setError("Wait for the live connection before sending an action.");
      return null;
    }
    if (!match?.connected) {
      setError(
        "Wait for the upstream party connection before sending an action.",
      );
      return null;
    }
    if (inFlight) {
      setError("Wait for the current action to finish.");
      return null;
    }
    const actionId = crypto.randomUUID();
    setInFlight({ id: actionId, command });
    setError("");
    setResult("Sending...");
    try {
      socket.send(JSON.stringify({ ...command, actionId }));
    } catch {
      socket.close();
      return null;
    }
    return actionId;
  }

  function retry() {
    setRetryAvailable(false);
    setError("");
    setRetryGeneration((current) => current + 1);
  }

  return {
    match,
    state,
    error,
    result,
    retryAvailable,
    inFlightAction: inFlight?.command ?? null,
    send,
    retry,
    fail: setError,
  };
}

function App() {
  const [tab, setTab] = useState<Tab>("play");
  const [draft, setDraft] = useState(loadStoredDraft);
  const [quote, setQuote] = useState<
    (MatchQuote & { idempotencyKey: string; setup: MatchSetup }) | null
  >(null);
  const [playBusy, setPlayBusy] = useState<"quote" | "create" | null>(null);
  const [playError, setPlayError] = useState("");
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const [initialRestoreState, setInitialRestoreState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [initialRestoreError, setInitialRestoreError] = useState("");
  const quoteVersion = useRef(0);
  const quoteController = useRef<AbortController | null>(null);
  const accountLoadVersion = useRef(0);
  const presetLoadVersion = useRef(0);
  const matchLoadVersion = useRef(0);
  const questionLoadVersion = useRef(0);
  const historyLoadVersion = useRef(0);
  const terminalMatchStates = useRef(new Map<string, string>());
  const initialRestoreAllowed = useRef(true);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [ttmcCatalog, setTtmcCatalog] = useState<TtmcCatalogResource>({ status: "idle" });
  const [ttmcCatalogRefresh, setTtmcCatalogRefresh] = useState(0);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountError, setAccountError] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [accountBusy, setAccountBusy] = useState<string | null>(null);

  const [presets, setPresets] = useState<TeamPreset[] | null>(null);
  const [presetSelections, setPresetSelections] = useState<
    Record<Side, string>
  >({ a: "", b: "" });
  const [presetBusy, setPresetBusy] = useState<string | null>(null);
  const [presetError, setPresetError] = useState("");

  const [matches, setMatches] = useState<Match[]>([]);
  const [questions, setQuestions] = useState<ObservedQuestion[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [currentMatchId, setCurrentMatchId] = useState<string | null>(null);
  const [resumingMatchId, setResumingMatchId] = useState<string | null>(null);
  const [cancellingMatchId, setCancellingMatchId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<Side, string>>({
    a: "",
    b: "",
  });
  const [ttmcAnswers, setTtmcAnswers] = useState<
    Partial<Record<Side, TtmcAnswer>>
  >({});
  const [ttmcDifficulties, setTtmcDifficulties] = useState<
    Record<Side, number>
  >({ a: 1, b: 1 });
  const live = useLiveMatch(
    currentMatchId,
    (command) => {
      if (command.type !== "answers") return;
      setAnswers((current) => ({
        ...current,
        ...Object.fromEntries(
          Object.entries(command.answers).map(([side, answer]) => [
            side,
            String(answer),
          ]),
        ),
      }));
    },
    (authoritativeMatch) => {
      if (![
        "finished",
        "failed",
        "cancelled",
      ].includes(authoritativeMatch.status.toLowerCase())) return;
      if (terminalMatchStates.current.has(authoritativeMatch.id)) return;
      terminalMatchStates.current.set(
        authoritativeMatch.id,
        authoritativeMatch.status,
      );
      matchLoadVersion.current += 1;
      setMatches((current) =>
        current.map((item) =>
          item.id === authoritativeMatch.id
            ? { ...item, status: authoritativeMatch.status }
            : item,
        ),
      );
      refreshQuote();
    },
  );

  function navigate(next: Tab) {
    initialRestoreAllowed.current = false;
    setTab(next);
  }

  function invalidateQuote() {
    quoteController.current?.abort();
    quoteController.current = null;
    quoteVersion.current += 1;
    setQuote(null);
    setPlayBusy((current) => current === "quote" ? null : current);
  }

  function refreshQuote() {
    invalidateQuote();
    setQuoteRefresh((current) => current + 1);
  }

  function editDraft(change: (current: Draft) => Draft) {
    invalidateQuote();
    setPlayError("");
    setDraft(change);
  }

  function editRoster(side: Side, change: RosterChange) {
    editDraft((current) => {
      const roster = current.teams[side].roster;
      let next = roster;
      if (change.type === "set")
        next = roster.map((player, index) =>
          index === change.index ? change.value : player,
        );
      if (change.type === "add" && roster.length < 12) next = [...roster, ""];
      if (change.type === "remove" && roster.length > 1)
        next = roster.filter((_, index) => index !== change.index);
      return {
        ...current,
        teams: {
          ...current.teams,
          [side]: { ...current.teams[side], roster: next },
        },
      };
    });
  }

  useEffect(() => {
    try {
      localStorage.setItem(
        draftStorageKey,
        JSON.stringify(draft),
      );
    } catch (error) {
      console.warn("Could not save the match setup.", error);
    }
  }, [draft]);

  function reconcileAccountAssignments(loaded: Account[]) {
    const active = loaded.filter(isActive);
    editDraft((current) => {
      const valid = (id: string) => active.some((account) => account.id === id);
      let a = valid(current.accountIds.a) ? current.accountIds.a : "";
      let b = valid(current.accountIds.b) ? current.accountIds.b : "";
      if (a === b) b = "";
      if (!a) a = active.find((account) => account.id !== b)?.id ?? "";
      if (!b) b = active.find((account) => account.id !== a)?.id ?? "";
      const accountIds = { a, b };
      const assignmentsUnchanged =
        a === current.accountIds.a && b === current.accountIds.b;
      return {
        ...current,
        accountIds,
        host: assignmentsUnchanged
          ? current.host
          : lowestBalanceSide(accountIds, active, current.host),
      };
    });
  }

  async function loadAccounts() {
    const version = ++accountLoadVersion.current;
    setLoadingAccounts(true);
    setAccountError("");
    try {
      const { accounts: loaded } = await getAccounts();
      if (accountLoadVersion.current !== version) return;
      setAccounts(loaded);
      reconcileAccountAssignments(loaded);
    } catch (error) {
      if (accountLoadVersion.current === version)
        setAccountError(
          errorMessage(error, "Could not load the account list."),
        );
    } finally {
      if (accountLoadVersion.current === version) setLoadingAccounts(false);
    }
  }

  async function loadPresets() {
    const version = ++presetLoadVersion.current;
    setPresetError("");
    try {
      const result = await getTeamPresets();
      if (presetLoadVersion.current === version) setPresets(result.presets);
    } catch (error) {
      if (presetLoadVersion.current === version)
        setPresetError(errorMessage(error, "Could not load team presets."));
    }
  }

  function reconcileTerminalMatchStates(loaded: Match[]) {
    return loaded.map((item) => {
      const terminalStatus = terminalMatchStates.current.get(item.id);
      return terminalStatus ? { ...item, status: terminalStatus } : item;
    });
  }

  useEffect(() => {
    void loadAccounts();
    void loadPresets();
  }, []);

  const ttmcHostAccountId = draft.accountIds[draft.host];
  const currentTtmcSetup = useEffectEvent(() => ({
    gameMode: draft.gameMode,
    hostAccountId: draft.accountIds[draft.host],
    rounds: draft.rounds,
    selection: draft.ttmcSelections[draft.accountIds[draft.host]],
  }));
  useEffect(() => {
    if (draft.gameMode !== "ttmc" || !ttmcHostAccountId) {
      setTtmcCatalog({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setTtmcCatalog({ status: "loading", hostAccountId: ttmcHostAccountId });
    void getTtmcCatalog(ttmcHostAccountId, controller.signal)
      .then((catalog) => {
        if (controller.signal.aborted) return;
        setTtmcCatalog({ status: "ready", hostAccountId: ttmcHostAccountId, data: catalog });
        const available = catalog.contents.map((item) => item.slug);
        const currentSetup = currentTtmcSetup();
        const previous = currentSetup.selection;
        const selected = previous?.all
          ? available
          : previous
            ? previous.slugs.filter((slug) => available.includes(slug))
            : available;
        const selection = { slugs: selected, all: previous?.all ?? true };
        const rounds = catalog.rounds;
        const roundsValid =
          currentSetup.rounds >= rounds.min &&
          currentSetup.rounds <= rounds.max &&
          (currentSetup.rounds - rounds.min) % rounds.step === 0;
        if (
          currentSetup.gameMode !== "ttmc" ||
          currentSetup.hostAccountId !== ttmcHostAccountId ||
          (currentSetup.selection?.all === selection.all &&
            selected.length === currentSetup.selection.slugs.length &&
            selected.every((slug, index) => slug === currentSetup.selection?.slugs[index]) &&
            roundsValid)
        ) return;
        editDraft((current) => {
          if (current.gameMode !== "ttmc" || current.accountIds[current.host] !== ttmcHostAccountId) return current;
          return {
            ...current,
            ttmcSelections: {
              ...current.ttmcSelections,
              [ttmcHostAccountId]: selection,
            },
            rounds: roundsValid ? current.rounds : rounds.default,
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTtmcCatalog({ status: "error", hostAccountId: ttmcHostAccountId, message: errorMessage(error, "Could not load TTMC packs.") });
      });
    return () => controller.abort();
  }, [draft.gameMode, ttmcHostAccountId, ttmcCatalogRefresh]);

  async function restoreInitialMatch() {
    const version = ++matchLoadVersion.current;
    setInitialRestoreState("loading");
    setInitialRestoreError("");
    try {
      const result = await getMatches();
      if (matchLoadVersion.current !== version) return;
      const reconciledMatches = reconcileTerminalMatchStates(result.matches);
      setMatches(reconciledMatches);
      let active = reconciledMatches.find(isResumableMatch);
      if (active?.status.toLowerCase() === "joining") {
        const resumed = await resumeMatch(active.id);
        if (matchLoadVersion.current !== version) return;
        active = resumed.match;
        setMatches((current) => [
          active!,
          ...current.filter((match) => match.id !== active!.id),
        ]);
      }
      setInitialRestoreState("ready");
      if (active && initialRestoreAllowed.current) {
        setCurrentMatchId(active.id);
        setTab("match");
      }
    } catch (error) {
      if (matchLoadVersion.current !== version) return;
      setInitialRestoreError(
        errorMessage(error, "Could not restore the active match."),
      );
      setInitialRestoreState("error");
    }
  }

  useEffect(() => {
    void restoreInitialMatch();
  }, []);

  async function loadMatches() {
    const loadingVersion = ++historyLoadVersion.current;
    const matchesVersion = ++matchLoadVersion.current;
    const questionsVersion = ++questionLoadVersion.current;
    setHistoryLoading(true);
    setHistoryError("");
    const [matchResult, questionResult] = await Promise.allSettled([
      getMatches(),
      getObservedQuestions(),
    ]);
    if (historyLoadVersion.current !== loadingVersion) return;
    const errors: string[] = [];
    if (
      matchResult.status === "fulfilled" &&
      matchLoadVersion.current === matchesVersion
    )
      setMatches(reconcileTerminalMatchStates(matchResult.value.matches));
    else if (matchResult.status === "rejected")
      errors.push(
        errorMessage(matchResult.reason, "Could not load match history."),
      );
    if (
      questionResult.status === "fulfilled" &&
      questionLoadVersion.current === questionsVersion
    )
      setQuestions(questionResult.value.questions);
    else if (questionResult.status === "rejected")
      errors.push(
        errorMessage(questionResult.reason, "Could not load question history."),
      );
    setHistoryError(errors.join(" "));
    setHistoryLoading(false);
  }

  useEffect(() => {
    if (tab === "history") void loadMatches();
  }, [tab]);

  const activeAccounts = accounts?.filter(isActive) ?? [];
  const selected = {
    a: accounts?.find((account) => account.id === draft.accountIds.a),
    b: accounts?.find((account) => account.id === draft.accountIds.b),
  };
  const cleanedTeams = {
    a: cleanTeam(draft.teams.a),
    b: cleanTeam(draft.teams.b),
  };
  const sharedSetup = {
    hostAccountId: draft.accountIds[draft.host],
    teamAAccountId: draft.accountIds.a,
    teamBAccountId: draft.accountIds.b,
    teamA: cleanedTeams.a,
    teamB: cleanedTeams.b,
  };
  const ttmcSelection = draft.ttmcSelections[ttmcHostAccountId];
  const ttmcContentSlugs = ttmcSelection?.slugs ?? [];
  const setup: MatchSetup =
    draft.gameMode === "proximo"
      ? {
          ...sharedSetup,
          gameMode: "proximo",
          contentSlug: draft.contentSlug,
          durationMinutes: draft.durationMinutes,
        }
      : {
          ...sharedSetup,
          gameMode: "ttmc",
          rounds: draft.rounds,
          ttmcContentSlugs,
        };
  const readyTtmcCatalog =
    ttmcCatalog.status === "ready" &&
    ttmcCatalog.hostAccountId === draft.accountIds[draft.host]
      ? ttmcCatalog.data
      : null;
  const ttmcCatalogReady = readyTtmcCatalog !== null;
  const ttmcCatalogLoading =
    ttmcCatalog.status === "loading" &&
    ttmcCatalog.hostAccountId === draft.accountIds[draft.host];
  const ttmcCatalogError =
    ttmcCatalog.status === "error" &&
    ttmcCatalog.hostAccountId === draft.accountIds[draft.host]
      ? ttmcCatalog.message
      : "";
  const ttmcOwned = readyTtmcCatalog?.owned === true;
  const ttmcContents = readyTtmcCatalog?.contents ?? [];
  const ttmcRounds = readyTtmcCatalog?.rounds;
  const ttmcRoundsValid = ttmcRounds !== undefined &&
    draft.rounds >= ttmcRounds.min &&
    draft.rounds <= ttmcRounds.max &&
    (draft.rounds - ttmcRounds.min) % ttmcRounds.step === 0;
  const ttmcSelectionValid =
    ttmcContentSlugs.length > 0 &&
    ttmcContentSlugs.every((slug) =>
      ttmcContents.some((content) => content.slug === slug),
    );
  const allTtmcContentsSelected =
    ttmcContents.length > 0 &&
    ttmcContentSlugs.length === ttmcContents.length &&
    ttmcContents.every((content) => ttmcContentSlugs.includes(content.slug));
  const ttmcContentSummary = ttmcContentSlugs
    .map((slug) => ttmcContents.find((content) => content.slug === slug))
    .filter((content): content is TtmcCatalog["contents"][number] => Boolean(content))
    .map((content) => `${content.title} (${content.slug})`)
    .join(" · ");
  const accountsReady = accounts !== null && !loadingAccounts;
  const setupValid =
    accountsReady &&
    activeAccounts.length >= 2 &&
    draft.accountIds.a !== draft.accountIds.b &&
    sides.every((side) =>
      activeAccounts.some((account) => account.id === draft.accountIds[side]),
    ) &&
    sides.every(
      (side) => cleanedTeams[side].name && cleanedTeams[side].roster.length,
    ) &&
    (draft.gameMode === "proximo" || (ttmcOwned && ttmcContents.length > 0 && ttmcSelectionValid && ttmcRoundsValid));
  const setupLocked = !accountsReady || playBusy === "create";
  const ttmcSetupBlocker = draft.gameMode !== "ttmc" ? "" :
    ttmcCatalogLoading ? "TTMC packs are still loading." :
    ttmcCatalogError ? "TTMC packs could not be loaded. Retry loading TTMC packs." :
    !ttmcCatalogReady ? "Choose a TTMC host to load its packs." :
    !ttmcOwned ? "The selected host does not own TTMC." :
    ttmcContents.length === 0 ? "No TTMC packs are available for the selected host." :
    !ttmcSelectionValid ? "Select at least one TTMC pack to price this match." :
     !ttmcRoundsValid ? "The TTMC topic count is unavailable." : "";

  const setupSignature = JSON.stringify(setup);
  const autoQuote = useEffectEvent(() => void requestQuote());
  useEffect(() => {
    if (!setupValid || initialRestoreState !== "ready") return;
    const timer = window.setTimeout(autoQuote, 300);
    return () => window.clearTimeout(timer);
  }, [setupSignature, setupValid, initialRestoreState, quoteRefresh]);

  useEffect(() => () => quoteController.current?.abort(), []);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAccountError("");
    setAccountBusy("challenge");
    try {
      const result = await createChallenge(email.trim());
      setChallenge(result.challenge);
      setCode("");
    } catch (error) {
      setAccountError(errorMessage(error, "Could not send a code."));
    } finally {
      setAccountBusy(null);
    }
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    setAccountError("");
    setAccountBusy("verify");
    try {
      await verifyChallenge(challenge.id, code.trim());
      setChallenge(null);
      setEmail("");
      setCode("");
      await loadAccounts();
      setTtmcCatalogRefresh((current) => current + 1);
    } catch (error) {
      setAccountError(errorMessage(error, "That code could not be confirmed."));
    } finally {
      setAccountBusy(null);
    }
  }

  async function updateAccount(id: string, operation: "refresh" | "remove") {
    if (
      operation === "remove" &&
      !window.confirm("Remove this account from Grooop Client?")
    )
      return;
    setAccountError("");
    setAccountBusy(`${operation}-${id}`);
    try {
      if (operation === "refresh") {
        accountLoadVersion.current += 1;
        const { account } = await refreshAccount(id);
        if (accounts === null) {
          console.warn("Received an account refresh while the account list is unavailable.");
          return;
        }
        const updated = accounts.map((item) =>
          item.id === id ? account : item,
        );
        setAccounts(updated);
        reconcileAccountAssignments(updated);
        if (id === ttmcHostAccountId) setTtmcCatalogRefresh((current) => current + 1);
      } else {
        await deleteAccount(id);
        await loadAccounts();
      }
    } catch (error) {
      if (
        operation === "refresh" &&
        error instanceof ApiError &&
        (error.status === 401 || error.code.includes("unauthorized"))
      ) {
        await loadAccounts();
      }
      setAccountError(
        errorMessage(error, `Could not ${operation} this account.`),
      );
    } finally {
      setAccountBusy(null);
    }
  }

  async function startReauthentication(id: string) {
    setAccountError("");
    setAccountBusy(`reauthenticate-${id}`);
    try {
      const result = await reauthenticateAccount(id);
      setChallenge(result.challenge);
      setCode("");
      setEmail("");
    } catch (error) {
      setAccountError(
        errorMessage(error, "Could not send a re-authentication code."),
      );
    } finally {
      setAccountBusy(null);
    }
  }

  function applyPreset(side: Side) {
    const preset = presets?.find((item) => item.id === presetSelections[side]);
    if (!preset) return;
    editDraft((current) => ({
      ...current,
      teams: {
        ...current.teams,
        [side]: { name: preset.name, roster: [...preset.roster] },
      },
    }));
  }

  async function savePreset(side: Side) {
    const input = cleanTeam(draft.teams[side]);
    if (!input.name || input.roster.length < 1) return;
    const selectedId = presetSelections[side];
    setPresetError("");
    setPresetBusy(`save-${side}`);
    presetLoadVersion.current += 1;
    try {
      const result = selectedId
        ? await updateTeamPreset(selectedId, input)
        : await createTeamPreset(input);
      setPresets((current) => [
        result.preset,
        ...(current ?? []).filter((preset) => preset.id !== result.preset.id),
      ]);
      setPresetSelections((current) => ({
        ...current,
        [side]: result.preset.id,
      }));
    } catch (error) {
      setPresetError(errorMessage(error, "Could not save this team preset."));
    } finally {
      setPresetBusy(null);
    }
  }

  async function removePreset(side: Side) {
    const id = presetSelections[side];
    if (!id || !window.confirm("Delete this team preset?")) return;
    setPresetError("");
    setPresetBusy(`delete-${side}`);
    presetLoadVersion.current += 1;
    try {
      await deleteTeamPreset(id);
      setPresets(
        (current) => current?.filter((preset) => preset.id !== id) ?? null,
      );
      setPresetSelections((current) => ({
        a: current.a === id ? "" : current.a,
        b: current.b === id ? "" : current.b,
      }));
    } catch (error) {
      setPresetError(errorMessage(error, "Could not delete this team preset."));
    } finally {
      setPresetBusy(null);
    }
  }

  async function requestQuote() {
    if (!setupValid || initialRestoreState !== "ready") {
      if (initialRestoreState !== "ready")
        setPlayError("Check for an active match before requesting a quote.");
      return;
    }
    const version = ++quoteVersion.current;
    quoteController.current?.abort();
    const controller = new AbortController();
    quoteController.current = controller;
    setQuote(null);
    setPlayBusy("quote");
    setPlayError("");
    try {
      const result = await quoteMatch(setup, controller.signal);
      if (quoteVersion.current === version) {
        setQuote({ ...result.quote, idempotencyKey: crypto.randomUUID(), setup });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (quoteVersion.current === version)
        setPlayError(errorMessage(error, "Could not quote this match."));
    } finally {
      if (quoteVersion.current === version) {
        quoteController.current = null;
        setPlayBusy(null);
      }
    }
  }

  function toggleTtmcContent(slug: string) {
    editDraft((current) => {
      const currentSlugs = current.ttmcSelections[ttmcHostAccountId]?.slugs ?? [];
      const selected = currentSlugs.includes(slug)
        ? currentSlugs.filter((item) => item !== slug)
        : [...currentSlugs, slug];
      const ordered = ttmcContents
        .map((content) => content.slug)
        .filter((contentSlug) => selected.includes(contentSlug));
      return {
        ...current,
        ttmcSelections: {
          ...current.ttmcSelections,
          [ttmcHostAccountId]: {
            slugs: ordered,
            all: ordered.length === ttmcContents.length,
          },
        },
      };
    });
  }

  function selectAllTtmcContents() {
    const slugs = ttmcContents.map((content) => content.slug);
    editDraft((current) => ({
      ...current,
      ttmcSelections: {
        ...current.ttmcSelections,
        [ttmcHostAccountId]: { slugs, all: true },
      },
    }));
  }

  async function submitMatch() {
    if (!quote?.userCanSpend || initialRestoreState !== "ready") {
      if (initialRestoreState !== "ready")
        setPlayError("Check for an active match before creating another one.");
      return;
    }
    setPlayBusy("create");
    setPlayError("");
    try {
      const result = await createMatch(quote.setup, quote.cost, quote.idempotencyKey);
      if (!isCancellableMatch(result.match)) {
        throw new Error(
          `The match returned an invalid status: ${result.match.status}.`,
        );
      }
      invalidateQuote();
      matchLoadVersion.current += 1;
      setMatches((current) => [
        result.match,
        ...current.filter((match) => match.id !== result.match.id),
      ]);
      setCurrentMatchId(result.match.id);
      navigate("match");
    } catch (error) {
      if (error instanceof ApiError && error.code === "party-cost-changed") {
        refreshQuote();
      }
      setPlayError(errorMessage(error, "Could not create this match."));
    } finally {
      setPlayBusy(null);
    }
  }

  function submitAnswers() {
    const game = proximoGame;
    if (!game || !isGameId(game.id) || !isRound(game.currentRound)) {
      live.fail(
        "The current game identity is unavailable; answers were not sent.",
      );
      return;
    }
    if (game.questionDeadlineAt === null) {
      live.fail("The question deadline is unavailable; answers were not sent.");
      return;
    }
    if (Date.now() >= game.questionDeadlineAt) {
      live.fail("Answering is closed for this question.");
      return;
    }
    const unresolved = sides.filter(
      (side) => !submitted[side],
    );
    const parsed = { a: Number(answers.a), b: Number(answers.b) };
    const complete = unresolved.filter(
      (side) =>
        answers[side] !== "" &&
        Number.isSafeInteger(parsed[side]) &&
        parsed[side] >= 0,
    );
    if (!complete.length) {
      const invalid = unresolved.find((side) => answers[side] !== "");
      live.fail(
        invalid
          ? `Team ${invalid.toUpperCase()} answer must be a nonnegative whole number.`
          : "Complete at least one team answer before locking.",
      );
      return;
    }
    const answerBatch: Partial<Record<Side, number>> = {};
    for (const side of complete) answerBatch[side] = parsed[side];
    const actionId = live.send({
      type: "answers",
      gameId: game.id,
      currentRound: game.currentRound,
      answers: answerBatch,
    });
    if (actionId)
      setAnswers((current) => ({
        ...current,
        ...Object.fromEntries(complete.map((side) => [side, ""])),
      }));
  }

  function startTtmcQuestion(side: Side) {
    const game = live.match?.gameMode === "ttmc" ? live.match.game : null;
    if (!game || game.teams[side].difficulty !== null) {
      live.fail("This team cannot start a TTMC question yet.");
      return;
    }
    live.send({
      type: "start-ttmc-question",
      roundId: game.id,
      side,
      difficulty: ttmcDifficulties[side] - 1,
    });
  }

  function submitTtmcAnswers() {
    const game = live.match?.gameMode === "ttmc" ? live.match.game : null;
    if (!game) {
      live.fail(
        "The current TTMC round identity is unavailable; answers were not sent.",
      );
      return;
    }
    const side = activeTtmcSide(game);
    if (!side || !game.teams[side].question) {
      live.fail("The active team's question is not ready.");
      return;
    }
    const batch: Partial<Record<Side, TtmcAnswer>> = {};
    const question = game.teams[side].question;
    const value = ttmcAnswerValue(question, ttmcAnswers[side]);
    if (!isCompleteTtmcAnswer(question, value)) {
      live.fail(`Complete Team ${side.toUpperCase()}'s answer before locking.`);
      return;
    }
    batch[side] =
      question.type === "oneword"
        ? (value as string).trim().toLowerCase()
        : value!;
    live.send({ type: "ttmc-answers", roundId: game.id, answers: batch });
  }

  function sendGameCommand(type: "ready" | "next-proximo") {
    const gameId = live.match?.game?.id;
    if (!isGameId(gameId)) {
      live.fail(
        "The current game identity is unavailable; the action was not sent.",
      );
      return;
    }
    live.send({ type, gameId });
  }

  function finishMatch() {
    if (window.confirm("End this match for both teams?"))
      live.send({ type: "finish" });
  }

  function openMatch(id: string) {
    initialRestoreAllowed.current = false;
    setCurrentMatchId(id);
    navigate("match");
  }

  async function resumeAndOpen(match: Match) {
    setHistoryError("");
    setResumingMatchId(match.id);
    try {
      const resumed =
        match.status.toLowerCase() === "joining"
          ? (await resumeMatch(match.id)).match
          : match;
      setMatches((current) => [
        resumed,
        ...current.filter((item) => item.id !== resumed.id),
      ]);
      openMatch(resumed.id);
    } catch (error) {
      setHistoryError(errorMessage(error, "Could not resume this match."));
    } finally {
      setResumingMatchId(null);
    }
  }

  async function cancelActiveMatch(match: Match) {
    if (!window.confirm(`Cancel ${match.teamA.name} vs ${match.teamB.name} for both teams?`)) return;
    setHistoryError("");
    setCancellingMatchId(match.id);
    try {
      const { match: cancelled } = await cancelMatch(match.id);
      terminalMatchStates.current.set(cancelled.id, cancelled.status);
      matchLoadVersion.current += 1;
      setMatches((current) => current.map((item) => item.id === cancelled.id ? cancelled : item));
      setCurrentMatchId((current) => current === cancelled.id ? null : current);
      refreshQuote();
    } catch (error) {
      setHistoryError(errorMessage(error, "Could not cancel this match."));
    } finally {
      setCancellingMatchId(null);
    }
  }

  const currentMatch = matches.find((match) => match.id === currentMatchId);
  const activeMatches = matches.filter(isResumableMatch);
  const pastMatches = matches.filter((match) => !isResumableMatch(match));
  const partyWaiting = live.match?.party.state.toLowerCase() === "waiting";
  const proximoGame =
    live.match?.gameMode === "proximo" ? live.match.game : null;
  const ttmcGame = live.match?.gameMode === "ttmc" ? live.match.game : null;
  const ttmcOrder = ttmcGame
    ? ttmcTurnOrder(ttmcGame.roundNumber)
    : (["a", "b"] satisfies [Side, Side]);
  const activeTtmcTeam = ttmcGame ? activeTtmcSide(ttmcGame) : null;
  const userIdBySide = {
    a: accounts?.find((account) => account.id === live.match?.teams.a.accountId)
      ?.userId,
    b: accounts?.find((account) => account.id === live.match?.teams.b.accountId)
      ?.userId,
  };
  function scoreForSide(side: Side): LiveScore | undefined {
    return proximoGame?.scores.find((score) => score.id === userIdBySide[side]);
  }
  const submitted = {
    a: scoreForSide("a")?.submitted === true,
    b: scoreForSide("b")?.submitted === true,
  };
  const gameRevealed = proximoGame?.showAnswer === true;
  const matchLive =
    live.match !== null &&
    !["finished", "failed", "cancelled"].includes(
      live.match.status.toLowerCase(),
    );
  const gameplayEnabled = live.state === "open" && live.match?.connected === true;
  const gameplayDraftDisabled =
    !gameplayEnabled || live.inFlightAction !== null;
  const gameReady =
    (proximoGame?.scores.length ?? 0) >= 2 &&
    proximoGame?.scores.every((score) => score.isReady) === true;
  const [autoReadyKey, setAutoReadyKey] = useState<string | null>(null);
  const autoReadyKeyRef = useRef<string | null>(null);
  const automaticallyReady = useEffectEvent((gameId: number) => {
    live.send({ type: "ready", gameId });
  });
  useEffect(() => {
    autoReadyKeyRef.current = null;
    setAutoReadyKey(null);
  }, [currentMatchId]);
  const proximoReadyKey =
    currentMatchId && proximoGame && isGameId(proximoGame.id)
      ? `${currentMatchId}:${proximoGame.id}`
      : null;
  useEffect(() => {
    if (
      !proximoGame || !isGameId(proximoGame.id) || gameReady || gameRevealed ||
      proximoGame.currentRound !== -1 || !gameplayEnabled || live.inFlightAction !== null ||
      !proximoReadyKey || autoReadyKeyRef.current === proximoReadyKey
    ) return;
    autoReadyKeyRef.current = proximoReadyKey;
    setAutoReadyKey(proximoReadyKey);
    automaticallyReady(proximoGame.id);
  }, [proximoGame, gameReady, gameRevealed, gameplayEnabled, live.inFlightAction, proximoReadyKey]);
  const questionActive =
    proximoGame?.showAnswer === false &&
    typeof proximoGame.question === "string" &&
    proximoGame.question.length > 0 &&
    typeof proximoGame.currentRound === "number" &&
    proximoGame.currentRound >= 0;
  const countdown = useQuestionCountdown(
    questionActive ? (proximoGame?.questionDeadlineAt ?? null) : null,
  );
  const sendingProximoAnswers =
    live.inFlightAction?.type === "answers"
      ? live.inFlightAction.answers
      : {};
  const locallyLockedProximo = {
    a: submitted.a || sendingProximoAnswers.a !== undefined,
    b: submitted.b || sendingProximoAnswers.b !== undefined,
  };
  const unresolvedSides = sides.filter(
    (side) => !locallyLockedProximo[side],
  );
  const readyProximoSides = unresolvedSides.filter((side) => {
    const parsed = Number(answers[side]);
    return (
      answers[side] !== "" &&
      Number.isSafeInteger(parsed) &&
      parsed >= 0
    );
  });
  const answeringClosed =
    questionActive &&
    (proximoGame?.questionDeadlineAt === null || countdown?.expired === true);
  const activeTtmcQuestion =
    ttmcGame && activeTtmcTeam
      ? ttmcGame.teams[activeTtmcTeam].question
      : null;
  const activeTtmcAnswerReady =
    activeTtmcQuestion !== null &&
    activeTtmcTeam !== null &&
    isCompleteTtmcAnswer(
      activeTtmcQuestion,
      ttmcAnswerValue(activeTtmcQuestion, ttmcAnswers[activeTtmcTeam]),
    );
  const finalTtmcRound =
    ttmcGame !== null && ttmcGame.roundNumber >= ttmcGame.totalRounds;
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const announcedQuestion = useRef("");
  const announcedReveal = useRef("");
  const announcedTtmcTopic = useRef("");
  const announcedTtmcQuestions = useRef<Record<Side, string>>({ a: "", b: "" });
  const announcedTtmcResult = useRef("");
  useEffect(() => {
    setAnswers({ a: "", b: "" });
    setTtmcAnswers({});
  }, [
    proximoGame?.id,
    proximoGame?.currentRound,
    ttmcGame?.id,
    ttmcGame?.roundNumber,
  ]);
  useEffect(() => {
    const game = proximoGame;
    if (!game || !isGameId(game.id) || !isRound(game.currentRound)) return;
    const key = `${game.id}:${game.currentRound}`;
    if (
      typeof game.question === "string" &&
      game.question &&
      !game.showAnswer &&
      announcedQuestion.current !== key
    ) {
      announcedQuestion.current = key;
      setLiveAnnouncement(`New question: ${game.question}`);
    } else if (game.showAnswer && announcedReveal.current !== key) {
      announcedReveal.current = key;
      setLiveAnnouncement(`Answer revealed: ${game.answer ?? "not supplied"}`);
    }
  }, [proximoGame]);
  useEffect(() => {
    if (!ttmcGame) return;
    const confirmed = sides.filter(
      (side) => ttmcGame.teams[side].submitted && ttmcAnswers[side] !== undefined,
    );
    if (!confirmed.length) return;
    setTtmcAnswers((current) => {
      const next = { ...current };
      for (const side of confirmed) delete next[side];
      return next;
    });
  }, [ttmcGame, ttmcAnswers]);
  useEffect(() => {
    const game = ttmcGame;
    if (!game) return;
    const announcements: string[] = [];
    const topicKey = `${game.id}:${game.roundNumber}:${game.category}:${game.title}`;
    if (announcedTtmcTopic.current !== topicKey) {
      announcedTtmcTopic.current = topicKey;
      announcements.push(
        `TTMC topic ${game.roundNumber} of ${game.totalRounds}: ${game.title ?? game.category ?? "topic pending"}`,
      );
    }
    for (const side of sides) {
      const question = game.teams[side].question;
      if (!question) continue;
      const questionKey = `${game.id}:${game.roundNumber}:${question.prompt}`;
      if (announcedTtmcQuestions.current[side] !== questionKey) {
        announcedTtmcQuestions.current[side] = questionKey;
        announcements.push(
          `Team ${side.toUpperCase()} question: ${question.prompt}`,
        );
      }
    }
    const resultKey = `${game.id}:${game.roundNumber}:result`;
    if (
      game.state === "finished" &&
      sides.every((side) => game.teams[side].success !== null) &&
      announcedTtmcResult.current !== resultKey
    ) {
      announcedTtmcResult.current = resultKey;
      announcements.push(
        `TTMC topic result: ${sides
          .map((side) => {
            const team = game.teams[side];
            return `Team ${side.toUpperCase()} ${team.success ? "correct" : "incorrect"}, ${team.points ?? 0} points`;
          })
          .join(". ")}`,
      );
    }
    if (announcements.length) setLiveAnnouncement(announcements.join(". "));
  }, [ttmcGame]);
  function sideForUserId(userId: number | null): Side | undefined {
    if (userId === null) return undefined;
    return sides.find((side) => userIdBySide[side] === userId);
  }

  return (
    <main className="app-shell">
      <header className="masthead">
        <a
          className="brand"
          href="#top"
          aria-label="Grooop Client home"
          onClick={() => navigate("play")}
        >
          <span className="brand-mark" aria-hidden="true">
            G!
          </span>
          <span>
            grooop
            <br />
            <b>party</b>
          </span>
        </a>
        <p className="eyebrow">
          One phone. Two teams.
          <br />
          No mercy.
        </p>
        <span className="issue">
          GAME NIGHT
          <br />
          EDITION 01
        </span>
      </header>
      <nav className="tabbar" aria-label="Game sections">
        {(["play", "match", "history", "settings"] as Tab[]).map(
          (item, index) => (
            <button
              key={item}
              type="button"
              className={tab === item ? "active" : ""}
              onClick={() => navigate(item)}
              aria-current={tab === item ? "page" : undefined}
            >
              <span>0{index + 1}</span>
              {item}
            </button>
          ),
        )}
      </nav>

      {tab === "play" && (
        <section className="page play-page" aria-labelledby="play-title">
          <div className="title-block">
            <p className="kicker">Set the table</p>
            <h1 id="play-title">
              LET’S
              <br />
              <i>PLAY.</i>
            </h1>
            <p>Build a round worth arguing about.</p>
          </div>
          <div className="notice">
            <b>Pass the phone.</b> One person hosts; everybody else brings a
            loud opinion.
          </div>
          <p className="setup-memory" role="status">
            Lineup and game setup save automatically on this device.
          </p>
          {initialRestoreState === "loading" && (
            <p className="restore-note" role="status">
              Checking for an active match before opening the match desk…
            </p>
          )}
          {initialRestoreState === "error" && (
            <div className="restore-error" role="alert">
              <b>Active-match check failed.</b> {initialRestoreError}
              <button
                type="button"
                onClick={() => void restoreInitialMatch()}
              >
                Retry active-match check
              </button>
            </div>
          )}
          {accountError && (
            <p className="api-error" role="alert">
              {accountError}
            </p>
          )}
          <div className="setup-grid" aria-disabled={setupLocked}>
            <section
              className="panel accounts-panel"
              aria-labelledby="lineup-title"
            >
              <div className="panel-heading">
                <span>01</span>
                <h2 id="lineup-title">The lineup</h2>
              </div>
              {!accountsReady ? (
                <div className="empty-state">
                  <strong>
                    {loadingAccounts
                      ? "Checking the guest list…"
                      : "Account setup is unavailable."}
                  </strong>
                  <p>
                    {loadingAccounts
                      ? "Hold the draw until the account list arrives."
                      : "Reload accounts in Settings before creating a match."}
                  </p>
                </div>
              ) : activeAccounts.length < 2 ? (
                <div className="empty-state">
                  <strong>Two active accounts needed.</strong>
                  <p>
                    Add or refresh accounts in Settings before dealing teams.
                  </p>
                  <button type="button" onClick={() => navigate("settings")}>
                    Go to settings →
                  </button>
                </div>
              ) : (
                <>
                  <div className="team-picks">
                    {sides.map((side) => (
                      <label key={side}>
                        Team {side.toUpperCase()} account
                        <select
                          disabled={setupLocked}
                          value={draft.accountIds[side]}
                          onChange={(event) =>
                            editDraft((current) => {
                              const accountIds = {
                                ...current.accountIds,
                                [side]: event.target.value,
                              };
                              return {
                                ...current,
                                accountIds,
                                host: lowestBalanceSide(
                                  accountIds,
                                  activeAccounts,
                                  current.host,
                                ),
                              };
                            })
                          }
                        >
                          {activeAccounts.map((account) => (
                            <option
                              key={account.id}
                              value={account.id}
                              disabled={
                                account.id ===
                                draft.accountIds[side === "a" ? "b" : "a"]
                              }
                            >
                              {account.email}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <label className="host-pick">
                    Host
                    <select
                      disabled={setupLocked}
                      value={draft.host}
                      onChange={(event) =>
                        editDraft((current) => ({
                          ...current,
                          host: event.target.value as Side,
                        }))
                      }
                    >
                      {sides.map((side) => (
                        <option key={side} value={side}>
                          Team {side.toUpperCase()} · {selected[side]?.email}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </section>
            <section className="panel" aria-labelledby="teams-title">
              <div className="panel-heading">
                <span>02</span>
                <h2 id="teams-title">Name your sides</h2>
              </div>
              {presetError && (
                <p className="api-error" role="alert">
                  {presetError}
                </p>
              )}
              <div className="team-names">
                {sides.map((side, index) => (
                  <div key={side} className="team-name-entry">
                    <label>
                      <span>{side.toUpperCase()}</span>
                      <input
                        disabled={setupLocked}
                        maxLength={40}
                        value={draft.teams[side].name}
                        onChange={(event) =>
                          editDraft((current) => ({
                            ...current,
                            teams: {
                              ...current.teams,
                              [side]: {
                                ...current.teams[side],
                                name: event.target.value,
                              },
                            },
                          }))
                        }
                        aria-label={`Team ${side.toUpperCase()} name`}
                      />
                    </label>
                    {index === 0 && <strong>VS</strong>}
                  </div>
                ))}
              </div>
              <div className="roster-columns">
                {sides.map((side) => (
                  <fieldset
                    className={`roster roster-${side}`}
                    key={side}
                    disabled={setupLocked}
                  >
                    <legend>Team {side.toUpperCase()} roster</legend>
                    <div className="preset-picker">
                      <label>
                        Saved team
                        <select
                          value={presetSelections[side]}
                          disabled={presets === null || presetBusy !== null}
                          onChange={(event) =>
                            setPresetSelections((current) => ({
                              ...current,
                              [side]: event.target.value,
                            }))
                          }
                        >
                          <option value="">New preset</option>
                          {presets?.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="preset-actions">
                        <button
                          type="button"
                          disabled={
                            !presetSelections[side] || presetBusy !== null
                          }
                          onClick={() => applyPreset(side)}
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          disabled={
                            presetBusy !== null ||
                            !cleanedTeams[side].name ||
                            cleanedTeams[side].roster.length === 0
                          }
                          onClick={() => void savePreset(side)}
                        >
                          {presetBusy === `save-${side}`
                            ? "Saving…"
                            : presetSelections[side]
                              ? "Update"
                              : "Save"}
                        </button>
                        <button
                          className="preset-delete"
                          type="button"
                          disabled={
                            !presetSelections[side] || presetBusy !== null
                          }
                          onClick={() => void removePreset(side)}
                        >
                          {presetBusy === `delete-${side}`
                            ? "Deleting…"
                            : "Delete"}
                        </button>
                      </div>
                    </div>
                    {draft.teams[side].roster.map((player, index) => (
                      <div className="roster-row" key={index}>
                        <label>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <input
                            required
                            maxLength={40}
                            value={player}
                            onChange={(event) =>
                              editRoster(side, {
                                type: "set",
                                index,
                                value: event.target.value,
                              })
                            }
                            aria-label={`Team ${side.toUpperCase()} player ${index + 1}`}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={draft.teams[side].roster.length === 1}
                          onClick={() =>
                            editRoster(side, { type: "remove", index })
                          }
                          aria-label={`Remove Team ${side.toUpperCase()} player ${index + 1}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      className="add-player"
                      type="button"
                      disabled={draft.teams[side].roster.length >= 12}
                      onClick={() => editRoster(side, { type: "add" })}
                    >
                      + Add player
                    </button>
                  </fieldset>
                ))}
              </div>
            </section>
            <section className="panel pack-panel" aria-labelledby="pack-title">
              <div className="panel-heading">
                <span>03</span>
                <h2 id="pack-title">Choose the game</h2>
              </div>
              <div className="mode-options">
                {[
                  {
                    mode: "proximo" as const,
                    title: "Proximo",
                    copy: "Timed number guesses. Pick a pack and duration.",
                  },
                  {
                    mode: "ttmc" as const,
                    title: "TTMC",
                    copy: "A round-by-round quiz with a chosen difficulty.",
                  },
                ].map(({ mode, title, copy }) => (
                  <label
                    key={mode}
                    className={draft.gameMode === mode ? "selected" : ""}
                  >
                    <input
                      disabled={setupLocked}
                      type="radio"
                      name="game-mode"
                      checked={draft.gameMode === mode}
                       onChange={() =>
                        editDraft((current) => ({ ...current, gameMode: mode }))
                      }
                    />
                    <b>{title}</b>
                    <span>{copy}</span>
                  </label>
                ))}
              </div>
              {draft.gameMode === "proximo" ? (
                <>
                  <div className="pack-options">
                    {content.map(([value, title, description]) => (
                      <label
                        key={value}
                        className={
                          draft.contentSlug === value ? "selected" : ""
                        }
                      >
                        <input
                          disabled={setupLocked}
                          type="radio"
                          name="pack"
                          value={value}
                          checked={draft.contentSlug === value}
                          onChange={() =>
                            editDraft((current) => ({
                              ...current,
                              contentSlug: value,
                            }))
                          }
                        />
                        <b>{title}</b>
                        <span>{description}</span>
                      </label>
                    ))}
                  </div>
                  <label className="duration">
                    Round duration
                    <select
                      disabled={setupLocked}
                      value={draft.durationMinutes}
                      onChange={(event) =>
                        editDraft((current) => ({
                          ...current,
                          durationMinutes: Number(event.target.value),
                        }))
                      }
                    >
                      <option value="15">15 minutes</option>
                      <option value="30">30 minutes</option>
                      <option value="45">45 minutes</option>
                    </select>
                  </label>
                </>
               ) : (
                 <>
                    <fieldset className="ttmc-packs">
                      <legend>TTMC packs</legend>
                      {ttmcCatalogLoading && <p className="loading">Loading the host’s TTMC packs…</p>}
                       {ttmcCatalogError && <div className="api-error" role="alert"><p>{ttmcCatalogError}</p><button className="retry-live" type="button" onClick={() => setTtmcCatalogRefresh((current) => current + 1)}>Retry loading TTMC packs</button></div>}
                       {ttmcCatalogReady && !ttmcOwned && <p className="api-error" role="alert">The selected host does not own TTMC.</p>}
                       {ttmcCatalogReady && ttmcOwned && ttmcContents.length === 0 && <p className="api-error" role="alert">No TTMC packs are available for the selected host.</p>}
                       {ttmcCatalogReady && (
                         <>
                           {ttmcOwned && ttmcContents.length > 0 && (allTtmcContentsSelected ? (
                             <p className="ttmc-all-packs selected" role="status">
                               <b>All packs selected</b>
                               <span>Use every available TTMC question pack</span>
                             </p>
                           ) : (
                             <button className="ttmc-all-packs" type="button" disabled={setupLocked} onClick={selectAllTtmcContents}>
                               <b>Select all packs</b>
                               <span>Use every available TTMC question pack</span>
                             </button>
                           ))}
                           {ttmcOwned && ttmcContents.length > 0 && <p className="ttmc-selection-help">Select at least one pack to play TTMC.</p>}
                            {ttmcOwned && ttmcContents.length > 0 && !ttmcSelectionValid && <p className="api-error" role="alert">Select at least one TTMC pack to price this match.</p>}
                           <div className="pack-options">
                             {ttmcContents.map((content) => {
                               const checked = ttmcContentSlugs.includes(content.slug);
                               return <label key={content.slug} className={checked ? "selected" : ""}>
                                 <input disabled={setupLocked || !ttmcOwned} type="checkbox" checked={checked} onChange={() => toggleTtmcContent(content.slug)} />
                                <b>{content.title}</b>
                                <span>{content.slug}</span>
                              </label>;
                            })}
                          </div>
                        </>
                      )}
                   </fieldset>
                   <label className="topic-count" htmlFor="ttmc-topics">
                     <span className="topic-count-heading">
                       Topics
                       <output htmlFor="ttmc-topics" aria-live="polite">
                         {draft.rounds}
                       </output>
                     </span>
                     <input
                       id="ttmc-topics"
                       aria-label="Topics"
                       aria-valuetext={`${draft.rounds} topics`}
                         disabled={setupLocked || !ttmcOwned || ttmcContents.length === 0 || !ttmcRounds}
                        type="range"
                        min={ttmcRounds?.min}
                        max={ttmcRounds?.max}
                        step={ttmcRounds?.step}
                       value={draft.rounds}
                       onChange={(event) =>
                         editDraft((current) => ({
                           ...current,
                           rounds: Number(event.target.value),
                         }))
                       }
                     />
                     <span className="topic-count-scale" aria-hidden="true">
                        <span>{ttmcRounds?.min ?? "–"}</span>
                        <span>{ttmcRounds?.max ?? "–"}</span>
                     </span>
                   </label>
                 </>
              )}
            </section>
          </div>
          <section className="cost-card" aria-label="Match quote">
            <div>
              <p className="kicker">Match desk</p>
              <h2>
                {draft.teams.a.name || "Team A"} <i>vs</i>{" "}
                {draft.teams.b.name || "Team B"}
              </h2>
              <p>
                {selected.a?.email ?? "Team A account"} /{" "}
                {selected.b?.email ?? "Team B account"} ·{" "}
                {draft.gameMode === "proximo"
                   ? `${draft.durationMinutes} min · Proximo ${draft.contentSlug}`
                   : `TTMC · ${draft.rounds} topics${ttmcContentSummary ? ` · ${ttmcContentSummary}` : ""}`}
              </p>
            </div>
            {quote ? (
              <div className="cost">
                <span>Exact cost</span>
                <b>{quote.cost} grooopies</b>
                <small>
                  Host balance {quote.hostBalance} · Guest balance{" "}
                  {quote.guestBalance}
                </small>
                <strong
                  className={quote.userCanSpend ? "can-spend" : "cannot-spend"}
                >
                  {quote.userCanSpend
                    ? "Ready to spend"
                    : "Insufficient balance"}
                </strong>
              </div>
            ) : (
              <div className="cost">
                <span>Cost</span>
                <b>
                  {playBusy === "quote"
                    ? "Pricing match…"
                    : setupValid
                      ? "Price unavailable"
                      : "Finish setup"}
                </b>
                <small>
                  {playBusy === "quote"
                    ? "Checking today’s exact price."
                    : setupValid
                      ? "Retry pricing when you’re ready."
                      : "Complete the match details to see the exact cost."}
                </small>
              </div>
            )}
            <p className="sr-only" role="status" aria-live="polite">
              {playBusy === "quote"
                ? "Pricing this match automatically."
                : quote
                  ? "Automatic pricing is complete."
                  : "Automatic pricing waits for a complete match setup."}
            </p>
            <div className="quote-actions">
              <button
                className="create-button"
                type="button"
                disabled={
                  !quote?.userCanSpend ||
                  playBusy !== null ||
                  initialRestoreState !== "ready"
                }
                onClick={() => void submitMatch()}
              >
                {playBusy === "create"
                  ? "Creating match…"
                  : quote
                    ? `Create match — ${quote.cost} grooopies →`
                    : playBusy === "quote"
                      ? "Pricing match…"
                      : "Finish setup"}
              </button>
              {!quote && playError && setupValid && initialRestoreState === "ready" && playBusy === null && (
                <button className="retry-quote" type="button" onClick={refreshQuote}>
                  Retry price
                </button>
              )}
            </div>
            {playError && (
              <p className="cost-error" role="alert">
                {playError}
              </p>
            )}
            {!setupValid && (
              <p className="cost-note">
                {ttmcSetupBlocker || "Choose two accounts, name both teams, and give each side 1 to 12 players."}
              </p>
            )}
          </section>
        </section>
      )}

      {tab === "match" && (
        <section className="page match-page" aria-labelledby="match-title">
          <p className="kicker">Grooop / live desk</p>
          <h1 id="match-title">
            ON
            <br />
            <i>THE AIR.</i>
          </h1>
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {liveAnnouncement}
          </p>
          {!currentMatchId ? (
            <div className="history-note">
              <span>?</span>
              <div>
                <h2>No match selected.</h2>
                <p>Create a match or open an active one from History.</p>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => navigate("play")}
                >
                  Set up a match →
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="live-strip" aria-live="polite">
                <span className={`socket-dot ${live.state}`} aria-hidden="true"></span>
                <b>{live.state === "open" ? "Live connection" : live.state}</b>
                <span>Match {currentMatchId}</span>
                {currentMatch && (
                  <span>
                    {currentMatch.teamA.name} vs {currentMatch.teamB.name}
                  </span>
                )}
              </div>
              {live.error && (
                <p className="api-error" role="alert">
                  {live.error}
                </p>
              )}
              {live.retryAvailable && (
                <button
                  className="retry-live"
                  type="button"
                  onClick={live.retry}
                >
                  Retry live connection
                </button>
              )}
              {live.result && (
                <p className="command-message" role="status">
                  {live.result}
                </p>
              )}
              {live.match?.gameMode === "ttmc" &&
                !ttmcGame &&
                matchLive &&
                ["waiting", "running"].includes(
                  live.match.party.state.toLowerCase(),
                ) && (
                  <button
                    className="retry-live"
                    type="button"
                    disabled={!gameplayEnabled || live.inFlightAction !== null}
                    onClick={() => live.send({ type: "start-ttmc-round" })}
                  >
                    {live.inFlightAction?.type === "start-ttmc-round"
                      ? "Starting topic…"
                      : "Start first topic →"}
                  </button>
                )}
              {!live.match ? (
                <div className="match-ticket">
                  <span>CONNECTING / {currentMatch?.status ?? "MATCH"}</span>
                  <b>
                    {currentMatch?.teamA.name ?? "TEAM A"} <i>vs</i>{" "}
                    {currentMatch?.teamB.name ?? "TEAM B"}
                  </b>
                  <p>
                    The live desk will appear as soon as the match socket sends
                    its first state.
                  </p>
                </div>
              ) : (
                <div className="live-layout">
                  <section
                    className="panel party-board"
                    aria-labelledby="party-title"
                  >
                    <div className="panel-heading">
                      <span>01</span>
                      <h2 id="party-title">Party floor</h2>
                    </div>
                    <dl className="state-list">
                      <div>
                        <dt>Match</dt>
                        <dd>{live.match.status}</dd>
                      </div>
                      <div>
                        <dt>Party</dt>
                        <dd>{live.match.party.state}</dd>
                      </div>
                      <div>
                        <dt>Players</dt>
                        <dd>{live.match.party.playerCount}</dd>
                      </div>
                      <div>
                        <dt>Connected</dt>
                        <dd>{live.match.connected ? "Yes" : "No"}</dd>
                      </div>
                    </dl>
                    <div className="team-live">
                      {sides.map((side) => (
                        <article key={side}>
                          <span>{side.toUpperCase()}</span>
                          <h3>{live.match!.teams[side].name}</h3>
                          <p>{live.match!.teams[side].roster.join(" · ")}</p>
                        </article>
                      ))}
                    </div>
                    <details>
                      <summary>Player state</summary>
                      <ul className="player-list">
                        {live.match.players.map((player, index) => (
                          <li key={player.id ?? index}>
                            <b>Player {player.id ?? index + 1}</b>
                            <span>
                              {player.isGameMaster ? "Game master" : "Player"} ·{" "}
                              {player.isConnected ? "connected" : "offline"} ·{" "}
                              {player.score === null
                                ? "score hidden"
                                : `${player.score} pts`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </section>
                  {live.match.gameMode === "ttmc" ? (
                    <section
                      className="panel game-board ttmc-board"
                      aria-labelledby="game-title"
                    >
                      <div className="panel-heading">
                        <span>02</span>
                        <h2 id="game-title">TTMC</h2>
                      </div>
                      {!ttmcGame ? (
                        <div className="empty-state">
                          <strong>
                            {partyWaiting
                              ? "Ready to start the first topic."
                              : "No topic in play."}
                          </strong>
                        </div>
                      ) : (
                        <>
                          <div className="game-meta">
                            <span>
                              {ttmcGame.category ?? "Category pending"}
                            </span>
                            <span>
                              Topic {ttmcGame.roundNumber} /{" "}
                              {ttmcGame.totalRounds}
                            </span>
                          </div>
                           <h3>
                             {ttmcGame.title ?? "Choose a difficulty to begin."}
                           </h3>
                           <div
                             className={`ttmc-next-step ${ttmcGame.state === "finished" ? "complete" : ""}`}
                             role="status"
                           >
                             <span>What happens now</span>
                             {!gameplayEnabled && matchLive ? (
                               <>
                                 <h4>Reconnecting to the game…</h4>
                                 <p>Keep this screen open. The current turn will unlock automatically.</p>
                               </>
                             ) : ttmcGame.state === "finished" ? (
                               finalTtmcRound ? (
                                 <>
                                   <h4>All topics are complete.</h4>
                                   <p>Both teams are finished. Waiting for Grooop to close the match.</p>
                                 </>
                               ) : (
                                 <>
                                   <h4>Topic complete. Start a fresh topic.</h4>
                                   <p>Both teams answered this topic. The next topic starts with Team {ttmcTurnOrder(ttmcGame.roundNumber + 1)[0].toUpperCase()}.</p>
                                   {matchLive && live.match.party.state.toLowerCase() === "running" ? (
                                     <button
                                       type="button"
                                       disabled={live.inFlightAction !== null}
                                       onClick={() =>
                                         live.send({
                                           type: "next-ttmc-round",
                                           roundId: ttmcGame.id,
                                         })
                                       }
                                     >
                                       {live.inFlightAction?.type === "next-ttmc-round"
                                         ? "Starting next topic…"
                                         : "Start next topic →"}
                                     </button>
                                   ) : (
                                     <p>Waiting for the party before the next topic can start.</p>
                                   )}
                                 </>
                               )
                             ) : !activeTtmcTeam ? (
                               <>
                                 <h4>Both answers are locked.</h4>
                                 <p>Waiting for Grooop to score this topic. No action is needed.</p>
                               </>
                             ) : ttmcGame.teams[activeTtmcTeam].difficulty === null ? (
                               <>
                                 <h4>Team {activeTtmcTeam.toUpperCase()} chooses its level.</h4>
                                 <p>Rate your own team from 1 to 10 below. Both teams play this same topic before moving on.</p>
                               </>
                             ) : ttmcGame.teams[activeTtmcTeam].question === null ? (
                               <>
                                 <h4>Opening Team {activeTtmcTeam.toUpperCase()}’s question…</h4>
                                 <p>No action is needed. The question will appear here automatically.</p>
                               </>
                             ) : (
                               <>
                                 <h4>Team {activeTtmcTeam.toUpperCase()} answers now.</h4>
                                 <p>The other team reads the question aloud. Choose an answer, then lock it below.</p>
                               </>
                             )}
                           </div>
                           <ol className="ttmc-turn-rail" aria-label="Topic turn order">
                             {ttmcOrder.map((side, index) => {
                               const done = ttmcGame.teams[side].submitted;
                               const active = side === activeTtmcTeam;
                               return (
                                 <li
                                   className={`side-${side} ${done ? "done" : active ? "active" : "waiting"}`}
                                   key={side}
                                 >
                                   <span>Turn {index + 1}</span>
                                   <b>{live.match!.teams[side].name}</b>
                                   <em>{done ? "Done" : active ? "Up now" : "Waiting"}</em>
                                 </li>
                               );
                             })}
                           </ol>
                           <div className="ttmc-teams">
                             {(ttmcGame.state === "finished"
                               ? sides
                               : activeTtmcTeam
                                 ? [activeTtmcTeam]
                                 : []
                             ).map((side) => {
                               const team = ttmcGame.teams[side];
                               const question = team.question;
                               const answer = ttmcAnswers[side];
                               const reader = side === "a" ? "b" : "a";
                               const finished =
                                 ttmcGame.state === "finished" &&
                                 team.success !== null;
                              return (
                                <article
                                  className={`ttmc-team side-${side}`}
                                  key={side}
                                >
                                 <span>
                                   {finished
                                     ? `TEAM ${side.toUpperCase()} RESULT`
                                     : `TURN ${ttmcOrder.indexOf(side) + 1} OF 2 · TEAM ${side.toUpperCase()}`}
                                 </span>
                                 <h4>{live.match!.teams[side].name}</h4>
                                 {team.difficulty === null &&
                                 ttmcGame.state === "running" ? (
                                   <div className="ttmc-rating">
                                     <p>
                                       <b>How well does your team know this topic?</b>
                                       Team {side.toUpperCase()} rates itself. Higher numbers mean a harder question worth more.
                                     </p>
                                     <fieldset
                                       className="difficulty-grid"
                                     >
                                       <legend className="sr-only">
                                         Team {side.toUpperCase()} difficulty
                                       </legend>
                                       {Array.from({ length: 10 }, (_, index) => index + 1).map((difficulty) => (
                                         <button
                                           type="button"
                                           key={difficulty}
                                           disabled={gameplayDraftDisabled}
                                           aria-pressed={ttmcDifficulties[side] === difficulty}
                                           onClick={() =>
                                             setTtmcDifficulties((current) => ({
                                               ...current,
                                               [side]: difficulty,
                                             }))
                                           }
                                         >
                                           {difficulty}
                                         </button>
                                       ))}
                                     </fieldset>
                                     <div className="difficulty-readout">
                                       <b>{ttmcDifficulties[side]} / 10</b>
                                       <span>
                                         {ttmcDifficulties[side] <= 3
                                           ? "Safe bet"
                                           : ttmcDifficulties[side] <= 6
                                             ? "Confident"
                                             : ttmcDifficulties[side] <= 8
                                               ? "Bold"
                                               : "All in"}
                                       </span>
                                     </div>
                                     <button
                                       className="difficulty-lock"
                                       type="button"
                                        disabled={
                                          !matchLive ||
                                          !gameplayEnabled ||
                                           live.inFlightAction !== null ||
                                          ttmcGame.state !== "running"
                                        }
                                        onClick={() => startTtmcQuestion(side)}
                                      >
                                       Lock in {ttmcDifficulties[side]} for Team {side.toUpperCase()} →
                                     </button>
                                   </div>
                                 ) : (
                                    <>
                                      <p>Difficulty {team.difficulty ?? "—"} / 10</p>
                                     {question && !team.submitted && (
                                       <div className="ttmc-question">
                                         <p className="reader-handoff">
                                           <b>Team {reader.toUpperCase()}, read this aloud.</b>
                                           Team {side.toUpperCase()} gives the final answer.
                                         </p>
                                          <b>{question.prompt}</b>
                                          <fieldset className="ttmc-answer-controls">
                                            <legend className="sr-only">
                                              Team {side.toUpperCase()} answer controls
                                            </legend>
                                           {question.type === "bool" && (
                                            <div className="choice-row">
                                              <button
                                                type="button"
                                                disabled={gameplayDraftDisabled}
                                                aria-pressed={answer === true}
                                                onClick={() =>
                                                  setTtmcAnswers((current) => ({
                                                    ...current,
                                                    [side]: true,
                                                  }))
                                                }
                                              >
                                                Yes
                                              </button>
                                              <button
                                                type="button"
                                                disabled={gameplayDraftDisabled}
                                                aria-pressed={answer === false}
                                                onClick={() =>
                                                  setTtmcAnswers((current) => ({
                                                    ...current,
                                                    [side]: false,
                                                  }))
                                                }
                                              >
                                                No
                                              </button>
                                            </div>
                                          )}
                                          {question.type === "qcm" && (
                                            <>
                                              <p className="answer-instruction">
                                                Choose {question.selectionCount}
                                              </p>
                                              <div className="choice-row">
                                                {question.options.map(
                                                  (option, index) => {
                                                    const chosen =
                                                      Array.isArray(answer) &&
                                                      answer.includes(index);
                                                    return (
                                                      <button
                                                        key={`${option}-${index}`}
                                                        type="button"
                                                        disabled={
                                                          gameplayDraftDisabled
                                                        }
                                                        aria-pressed={chosen}
                                                        onClick={() =>
                                                          setTtmcAnswers(
                                                            (current) => {
                                                              const selected =
                                                                Array.isArray(
                                                                  current[side],
                                                                )
                                                                  ? (current[
                                                                      side
                                                                    ] as number[])
                                                                  : [];
                                                              return {
                                                                ...current,
                                                                [side]: chosen
                                                                  ? selected.filter(
                                                                      (item) =>
                                                                        item !==
                                                                        index,
                                                                    )
                                                                  : selected.length <
                                                                      question.selectionCount
                                                                    ? [
                                                                        ...selected,
                                                                        index,
                                                                      ]
                                                                    : selected,
                                                              };
                                                            },
                                                          )
                                                        }
                                                      >
                                                        {option}
                                                      </button>
                                                    );
                                                  },
                                                )}
                                              </div>
                                            </>
                                          )}
                                          {question.type === "number" && (
                                            <label>
                                              Answer{" "}
                                              <input
                                                aria-label={`Team ${side.toUpperCase()} answer`}
                                                type="range"
                                                min={question.min}
                                                max={question.max}
                                                step={question.step}
                                                disabled={
                                                  gameplayDraftDisabled
                                                }
                                                value={
                                                  typeof answer === "number"
                                                    ? answer
                                                    : question.min
                                                }
                                                onChange={(event) =>
                                                  setTtmcAnswers((current) => ({
                                                    ...current,
                                                    [side]: Number(
                                                      event.target.value,
                                                    ),
                                                  }))
                                                }
                                              />
                                              <b>
                                                {typeof answer === "number"
                                                  ? answer
                                                  : question.min}
                                              </b>
                                            </label>
                                          )}
                                          {question.type === "oneword" && (
                                            <input
                                              aria-label={`Team ${side.toUpperCase()} answer`}
                                              disabled={gameplayDraftDisabled}
                                              value={
                                                typeof answer === "string"
                                                  ? answer
                                                  : ""
                                              }
                                              onChange={(event) =>
                                                setTtmcAnswers((current) => ({
                                                  ...current,
                                                  [side]: event.target.value,
                                                }))
                                              }
                                            />
                                          )}
                                           {question.type === "words" && (
                                            <>
                                              <p className="answer-instruction">
                                                Build a{" "}
                                                {question.answerWordCount}-word
                                                answer
                                              </p>
                                              <div className="choice-row">
                                                {question.candidates.map(
                                                  (word, index) => {
                                                    const selectedWords =
                                                      Array.isArray(answer)
                                                        ? (answer as string[])
                                                        : [];
                                                    const used =
                                                      selectedWords.filter(
                                                        (item) => item === word,
                                                      ).length;
                                                    const available =
                                                      question.candidates.filter(
                                                        (item) => item === word,
                                                      ).length;
                                                    return (
                                                      <button
                                                        key={`${word}-${index}`}
                                                        type="button"
                                                        disabled={
                                                          gameplayDraftDisabled ||
                                                          selectedWords.length >=
                                                            question.answerWordCount ||
                                                          used >= available
                                                        }
                                                        onClick={() =>
                                                          setTtmcAnswers(
                                                            (current) => ({
                                                              ...current,
                                                              [side]: [
                                                                ...(Array.isArray(
                                                                  current[side],
                                                                )
                                                                  ? (current[
                                                                      side
                                                                    ] as string[])
                                                                  : []),
                                                                word,
                                                              ],
                                                            }),
                                                          )
                                                        }
                                                      >
                                                        {word}
                                                      </button>
                                                    );
                                                  },
                                                )}
                                              </div>
                                              <p className="word-answer">
                                                {Array.isArray(answer) &&
                                                  answer.map((word, index) => (
                                                    <button
                                                      key={`${word}-${index}`}
                                                      type="button"
                                                      disabled={
                                                        gameplayDraftDisabled
                                                      }
                                                      onClick={() =>
                                                        setTtmcAnswers(
                                                          (current) => ({
                                                            ...current,
                                                            [side]: (
                                                              current[
                                                                side
                                                              ] as string[]
                                                            ).filter(
                                                              (_, itemIndex) =>
                                                                itemIndex !==
                                                                index,
                                                            ),
                                                          }),
                                                        )
                                                      }
                                                    >
                                                      {word} ×
                                                    </button>
                                                  ))}
                                                <button
                                                  type="button"
                                                  disabled={
                                                    gameplayDraftDisabled
                                                  }
                                                  onClick={() =>
                                                    setTtmcAnswers(
                                                      (current) => ({
                                                        ...current,
                                                        [side]: [],
                                                      }),
                                                    )
                                                  }
                                                >
                                                  Clear
                                                </button>
                                              </p>
                                             </>
                                           )}
                                          </fieldset>
                                         </div>
                                      )}
                                      {team.submitted && !finished && (
                                        <p className="submitted-note">
                                          Submitted
                                        </p>
                                      )}
                                      {finished && (
                                        <div className="official-answer">
                                          <span>
                                            {team.success
                                              ? "Correct"
                                              : "Incorrect"}{" "}
                                            · {team.points ?? 0} points
                                          </span>
                                          <b>
                                            {Array.isArray(team.officialAnswer)
                                              ? team.officialAnswer.join(" · ")
                                              : typeof team.officialAnswer ===
                                                    "object" &&
                                                  team.officialAnswer
                                                ? `${team.officialAnswer.value} ± ${team.officialAnswer.tolerance}`
                                                : (team.officialAnswer ??
                                                  "No official answer")}
                                          </b>
                                        </div>
                                      )}
                                    </>
                                  )}
                                </article>
                               );
                             })}
                             {ttmcGame.state === "running" && !activeTtmcTeam && (
                               <p className="waiting-note" role="status">
                                 Both turns are locked. Waiting for the topic result.
                               </p>
                             )}
                           </div>
                        </>
                      )}
                    </section>
                  ) : (
                    <section
                      className="panel game-board"
                      aria-labelledby="game-title"
                    >
                      <div className="panel-heading">
                        <span>02</span>
                        <h2 id="game-title">Proximo</h2>
                      </div>
                      {!proximoGame ? (
                        <div className="empty-state">
                          <strong>
                            {partyWaiting
                              ? "Waiting for the party to begin."
                              : "No game in play."}
                          </strong>
                          <p>
                            {partyWaiting
                              ? "Start the party outside this desk; controls unlock once it is running."
                              : `Party state: ${live.match.party.state}`}
                          </p>
                        </div>
                      ) : (
                        <>
                          <div className="game-meta">
                            <span>
                              {proximoGame.category ?? "Category pending"}
                            </span>
                            <span>Round {proximoGame.currentRound ?? "—"}</span>
                            <span>
                              {proximoGame.questionDurationSeconds === null
                                ? "Duration pending"
                                : `${proximoGame.questionDurationSeconds}s per question`}
                            </span>
                          </div>
                          {questionActive && (
                            <div
                              className={`question-timer ${countdown?.urgent ? "urgent" : ""} ${countdown?.expired ? "expired" : ""}`}
                              role="timer"
                              aria-live="off"
                            >
                              <span>Time left</span>
                              <b>{countdown?.label ?? "—:—"}</b>
                            </div>
                          )}
                          <h3>
                            {proximoGame.question ??
                              "Waiting for the question…"}
                          </h3>
                          <p className="game-state">
                            Game state:{" "}
                            <b>{proximoGame.state ?? "synchronizing"}</b>
                          </p>
                          {proximoGame.showAnswer && (
                            <div className="official-answer">
                              <span>Official answer</span>
                              <b>{proximoGame.answer ?? "Not supplied"}</b>
                            </div>
                          )}
                          <div className="scores">
                            <span>Scores</span>
                            {proximoGame.scores.length === 0 ? (
                              <b>Waiting for teams</b>
                            ) : (
                              <ul className="score-list">
                                {proximoGame.scores.map((score, index) => {
                                  const scoreSide = sideForUserId(score.id);
                                  return (
                                    <li key={score.id ?? index}>
                                      <b>
                                        {scoreSide
                                          ? `Team ${scoreSide.toUpperCase()}`
                                          : "Unknown team"}
                                      </b>
                                      <span>
                                        {score.isReady ? "Ready" : "Not ready"}{" "}
                                        ·{" "}
                                        {score.submitted
                                          ? "submitted"
                                          : "no answer"}
                                        {!gameRevealed || score.delta === null
                                          ? ""
                                          : ` · gap ${score.delta >= 0 ? "+" : ""}${score.delta}`}
                                      </span>
                                      {gameRevealed &&
                                        score.answer !== null && (
                                          <strong>Answer {score.answer}</strong>
                                        )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        </>
                      )}
                    </section>
                  )}
                  <section
                    className="control-deck"
                    aria-labelledby="controls-title"
                  >
                    <div>
                      <p className="kicker">Make the call</p>
                      <h2 id="controls-title">Controls</h2>
                    </div>
                    <div className="command-buttons">
                      {live.match.gameMode === "proximo" &&
                        !proximoGame &&
                        partyWaiting && (
                          <p className="control-note">
                            The party is waiting. No live action is available
                            yet.
                          </p>
                        )}
                      {live.match.gameMode === "proximo" &&
                        !proximoGame &&
                        !partyWaiting &&
                        matchLive && (
                          <button
                            disabled={
                               !gameplayEnabled || live.inFlightAction !== null
                            }
                            type="button"
                            onClick={() => live.send({ type: "start-proximo" })}
                          >
                            {live.inFlightAction?.type === "start-proximo"
                              ? "Setting up question…"
                              : "Start first question →"}
                          </button>
                        )}
                      {proximoGame &&
                        !gameRevealed &&
                        !gameReady &&
                        matchLive && (
                          live.inFlightAction?.type === "ready" ? (
                            <p className="control-note" role="status">
                              Opening the question…
                            </p>
                          ) : autoReadyKey === proximoReadyKey ? (
                            <button
                              disabled={!gameplayEnabled || live.inFlightAction !== null}
                              type="button"
                              onClick={() => live.send({ type: "ready", gameId: proximoGame.id })}
                            >
                              Retry opening question
                            </button>
                          ) : (
                            <p className="control-note" role="status">
                              Question setup is synchronizing…
                            </p>
                          )
                        )}
                      {proximoGame &&
                        gameRevealed &&
                        matchLive &&
                        live.match.party.state.toLowerCase() === "running" && (
                          <button
                            disabled={
                               !gameplayEnabled || live.inFlightAction !== null
                            }
                            type="button"
                            onClick={() => sendGameCommand("next-proximo")}
                          >
                            {live.inFlightAction?.type === "next-proximo"
                              ? "Adding question…"
                              : "Start next question →"}
                          </button>
                        )}
                    </div>
                    {proximoGame && questionActive && (
                      <div className="answer-grid">
                        {sides.map((side) => (
                          <label key={side}>
                            Team {side.toUpperCase()} answer
                            {locallyLockedProximo[side] ? (
                              <span className="submitted-note">
                                {submitted[side] ? "Submitted" : "Sending…"}
                              </span>
                            ) : (
                              unresolvedSides.length === 1 && (
                                <span className="unresolved-note">
                                  Still needed
                                </span>
                              )
                            )}
                            <input
                              disabled={
                                locallyLockedProximo[side] ||
                                !gameplayEnabled ||
                                 live.inFlightAction !== null ||
                                answeringClosed
                              }
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={
                                locallyLockedProximo[side] ? "" : answers[side]
                              }
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  [side]: event.target.value,
                                }))
                              }
                            />
                          </label>
                        ))}
                        {answeringClosed && (
                          <p className="answer-closed" role="status">
                            Answering is closed for this question.
                          </p>
                        )}
                        <button
                          className="lock-both"
                          disabled={
                            readyProximoSides.length === 0 ||
                            !gameplayEnabled ||
                             live.inFlightAction !== null ||
                            answeringClosed
                          }
                          type="button"
                          onClick={submitAnswers}
                        >
                          {answeringClosed
                            ? "Answering closed"
                            : live.inFlightAction?.type === "answers"
                               ? "Locking answers…"
                              : unresolvedSides.length === 0
                                ? "Both answers locked"
                                : readyProximoSides.length === 1
                                  ? `Lock Team ${readyProximoSides[0].toUpperCase()} answer`
                                  : "Lock both answers"}
                        </button>
                      </div>
                    )}
                    {ttmcGame && (
                      <div className="answer-grid ttmc-lock">
                        {ttmcGame.state === "running" && (
                          <button
                            className="lock-both"
                            type="button"
                            disabled={
                               !gameplayEnabled ||
                                live.inFlightAction !== null ||
                               !activeTtmcAnswerReady
                             }
                            onClick={submitTtmcAnswers}
                          >
                             {live.inFlightAction?.type === "ttmc-answers"
                               ? "Locking answers…"
                               : activeTtmcTeam
                                 ? `Lock Team ${activeTtmcTeam.toUpperCase()} answer`
                                 : "Both turns locked"}
                          </button>
                        )}
                       </div>
                    )}
                    {matchLive && live.match.gameMode === "proximo" && (
                      <button
                        className="finish-action"
                        disabled={
                           !gameplayEnabled || live.inFlightAction !== null
                        }
                        type="button"
                        onClick={finishMatch}
                      >
                        End match
                      </button>
                    )}
                    {!matchLive && (
                      <p className="terminal-note">
                        This match is closed. Its result remains in History.
                      </p>
                    )}
                  </section>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {tab === "history" && (
        <section className="page history-page" aria-labelledby="history-title">
          <p className="kicker">After the noise</p>
          <h1 id="history-title">
            THE
            <br />
            <i>RECORD.</i>
          </h1>
          {historyError && (
            <p className="api-error" role="alert">
              {historyError}
            </p>
          )}
          {historyLoading ? (
            <p className="loading">Opening the match ledger…</p>
          ) : matches.length === 0 ? (
            <div className="history-note">
              <span>0</span>
              <div>
                <h2>No matches yet.</h2>
                <p>The first game will leave its paper trail here.</p>
              </div>
            </div>
          ) : (
            <>
              {[
                { title: "Active matches", items: activeMatches },
                { title: "Past matches", items: pastMatches },
              ].filter((group) => group.items.length > 0).map((group) => (
                <section className="match-group" key={group.title} aria-label={group.title}>
                  <h2>{group.title}</h2>
                  <ol className="match-list">
                    {group.items.map((match, index) => (
                      <li key={match.id}>
                        <div className="match-number">
                          {String(index + 1).padStart(2, "0")}
                        </div>
                        <div>
                          <span className={`match-status status-${match.status.toLowerCase()}`}>
                            {match.status}
                          </span>
                          <h2>
                            {match.teamA.name} <i>vs</i> {match.teamB.name}
                          </h2>
                          <p>
                            {match.gameMode === "ttmc"
                              ? `TTMC · ${match.rounds} topics · ${match.ttmcContentSlugs.join(" · ")}`
                              : `Proximo ${match.contentSlug} · ${match.durationMinutes} minutes`}{" "}
                            · {match.cost} grooopies
                          </p>
                          <time dateTime={match.createdAt}>
                            {new Date(match.createdAt).toLocaleString()}
                          </time>
                          {match.error && <p className="match-error">{match.error}</p>}
                        </div>
                        {isResumableMatch(match) && (
                          <div className="match-actions">
                            <button
                              type="button"
                              disabled={resumingMatchId !== null || cancellingMatchId !== null}
                              onClick={() => void resumeAndOpen(match)}
                            >
                              {resumingMatchId === match.id
                                ? "Resuming…"
                                : match.status.toLowerCase() === "joining"
                                  ? "Resume setup →"
                                  : "Open live →"}
                            </button>
                            {isCancellableMatch(match) && (
                              <button
                                className="cancel-match"
                                type="button"
                                disabled={resumingMatchId !== null || cancellingMatchId !== null}
                                onClick={() => void cancelActiveMatch(match)}
                              >
                                {cancellingMatchId === match.id ? "Cancelling…" : "Cancel match"}
                              </button>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </>
          )}
          {questions && questions.length > 0 && (
            <section
              className="question-history"
              aria-labelledby="question-history-title"
            >
              <div>
                <p className="kicker">Seen in play</p>
                <h2 id="question-history-title">Question archive</h2>
              </div>
              <ol>
                {questions.map((item, index) => (
                  <li key={`${item.firstSeenAt}-${index}`}>
                    <div>
                      <span>
                        {item.content}
                        {item.category ? ` / ${item.category}` : ""}
                      </span>
                      <time dateTime={item.firstSeenAt}>
                        {new Date(item.firstSeenAt).toLocaleString()}
                      </time>
                    </div>
                    <h3>{item.question}</h3>
                    <p>
                      Answer: <b>{item.answer}</b>
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </section>
      )}

      {tab === "settings" && (
        <section
          className="page settings-page"
          aria-labelledby="settings-title"
        >
          <div className="title-block">
            <p className="kicker">Keep the cupboard stocked</p>
            <h1 id="settings-title">
              YOUR
              <br />
              <i>ACCOUNTS.</i>
            </h1>
          </div>
          {accountError && (
            <p className="api-error" role="alert">
              {accountError}
            </p>
          )}
          <div className="settings-grid">
            <section className="panel" aria-labelledby="accounts-title">
              <div className="panel-heading">
                <span>01</span>
                <h2 id="accounts-title">Connected accounts</h2>
              </div>
              {loadingAccounts ? (
                <p className="loading">Checking the guest list…</p>
              ) : accounts === null ? (
                <div className="empty-state">
                  <strong>Account list unavailable.</strong>
                  <button type="button" onClick={() => void loadAccounts()}>
                    Try again →
                  </button>
                </div>
              ) : accounts.length === 0 ? (
                <p className="loading">No accounts yet. Add one to start.</p>
              ) : (
                <ul className="account-list">
                  {accounts.map((account) => (
                    <li key={account.id}>
                      <div>
                        <b>{account.email}</b>
                        <span
                          className={`status ${isActive(account) ? "active" : ""}`}
                        >
                          {account.status} · {account.grooopies} grooopies
                        </span>
                      </div>
                      <div className="account-actions">
                        {isActive(account) ? (
                          <button
                            type="button"
                            disabled={accountBusy !== null}
                            onClick={() =>
                              void updateAccount(account.id, "refresh")
                            }
                          >
                            {accountBusy === `refresh-${account.id}`
                              ? "Refreshing…"
                              : "Refresh"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={accountBusy !== null}
                            onClick={() =>
                              void startReauthentication(account.id)
                            }
                          >
                            {accountBusy === `reauthenticate-${account.id}`
                              ? "Sending…"
                              : "Re-authenticate"}
                          </button>
                        )}
                        <button
                          className="danger"
                          type="button"
                          disabled={accountBusy !== null}
                          onClick={() =>
                            void updateAccount(account.id, "remove")
                          }
                        >
                          {accountBusy === `remove-${account.id}`
                            ? "Removing…"
                            : "Remove"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel add-account" aria-labelledby="add-title">
              <div className="panel-heading">
                <span>02</span>
                <h2 id="add-title">
                  {challenge ? "Verify an account" : "Add an account"}
                </h2>
              </div>
              {!challenge ? (
                <form onSubmit={(event) => void requestCode(event)}>
                  <label>
                    Email address
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="team@example.com"
                      autoComplete="email"
                    />
                  </label>
                  <button type="submit" disabled={accountBusy !== null}>
                    {accountBusy === "challenge"
                      ? "Sending code…"
                      : "Send verification code →"}
                  </button>
                </form>
              ) : (
                <form onSubmit={(event) => void confirmCode(event)}>
                  <p className="code-sent">
                    Code sent to <b>{challenge.email}</b>. Check the inbox, then
                    enter it below.
                  </p>
                  <label>
                    Verification code
                    <input
                      required
                      minLength={8}
                      maxLength={8}
                      pattern="[A-Z0-9]{8}"
                      title="Enter the 8-character uppercase code"
                      value={code}
                      onChange={(event) =>
                        setCode(
                          event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9]/g, "")
                            .slice(0, 8),
                        )
                      }
                      inputMode="text"
                      autoCapitalize="characters"
                      autoComplete="one-time-code"
                      placeholder="AB12CD34"
                    />
                  </label>
                  <button type="submit" disabled={accountBusy !== null}>
                    {accountBusy === "verify"
                      ? "Verifying…"
                      : "Verify account →"}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setChallenge(null)}
                  >
                    Use a different email
                  </button>
                </form>
              )}
            </section>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
