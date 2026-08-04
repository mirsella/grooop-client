<script lang="ts">
  import { onMount } from 'svelte'
  import type { AppState } from '../lib/app-state.svelte'
  import { isGameId, sides } from '../lib/domain'
  let { state: app }: { state: AppState } = $props()
  let now = $state(Date.now())
  onMount(() => {
    const timer = window.setInterval(() => now = Date.now(), 50)
    return () => window.clearInterval(timer)
  })
  const game = $derived(app.proximoGame)
  const revealed = $derived(game?.showAnswer === true)
  const questionActive = $derived(game?.showAnswer === false && Boolean(game.question) && typeof game.currentRound === 'number' && game.currentRound >= 0)
  const seconds = $derived(game?.questionDeadlineAt === null || game?.questionDeadlineAt === undefined ? 0 : Math.max(0, Math.ceil((game.questionDeadlineAt - Math.max(now, Date.now())) / 1000)))
  const timerLabel = $derived(`${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`)
  const answeringClosed = $derived(questionActive && (game?.questionDeadlineAt === null || seconds === 0))
  const submitted = $derived(app.proximoSubmitted)
  const sending = $derived(app.live.inFlight?.command.type === 'answers' ? app.live.inFlight.command.answers : {})
  const locallyLocked = $derived({ a: submitted.a || sending.a !== undefined, b: submitted.b || sending.b !== undefined })
  const unresolved = $derived(sides.filter((side) => !locallyLocked[side]))
  const ready = $derived(unresolved.filter((side) => app.answers[side] !== '' && Number.isSafeInteger(Number(app.answers[side])) && Number(app.answers[side]) >= 0))
  const readyKey = $derived(app.currentMatchId && game && isGameId(game.id) ? `${app.currentMatchId}:${game.id}` : null)
</script>

<section class="panel game-board" aria-labelledby="game-title">
  <header class="panel-heading"><span>02</span><h2 id="game-title">Proximo</h2></header>
  {#if !game}
    <div class="empty-state"><strong>{app.live.match?.party.state.toLowerCase() === 'waiting' ? 'Waiting for the party to begin.' : 'No game in play.'}</strong><p>Party state: {app.live.match?.party.state}</p></div>
  {:else}
    <div class="game-meta"><span>{game.category ?? 'Category pending'}</span><span>Round {game.currentRound ?? '—'}</span><span>{game.questionDurationSeconds === null ? 'Duration pending' : `${game.questionDurationSeconds}s per question`}</span></div>
    {#if questionActive}<div class:urgent={seconds <= 10} class:expired={seconds === 0} class="question-timer" role="timer" aria-live="off"><span>Time left</span><b>{timerLabel}</b></div>{/if}
    <h3>{game.question ?? 'Waiting for the question…'}</h3>
    <p class="game-state">Game state: <b>{game.state ?? 'synchronizing'}</b></p>
    {#if revealed}<div class="official-answer"><span>Official answer</span><b>{game.answer ?? 'Not supplied'}</b></div>{/if}
    <div class="scores"><span>Scores</span>
      {#if !game.scores.length}<b>Waiting for teams</b>{:else}
        <ul class="score-list">
          {#each game.scores as score, index}
            {@const side = app.sideForUserId(score.id)}
            <li><b>{side ? `Team ${side.toUpperCase()}` : `Unknown team ${index + 1}`}</b><span>{score.isReady ? 'Ready' : 'Not ready'} · {score.submitted ? 'submitted' : 'no answer'}{revealed && score.delta !== null ? ` · gap ${score.delta >= 0 ? '+' : ''}${score.delta}` : ''}</span>{#if revealed && score.answer !== null}<strong>Answer {score.answer}</strong>{/if}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<section class="control-deck" aria-labelledby="controls-title">
  <div><p class="kicker">Make the call</p><h2 id="controls-title">Controls</h2></div>
  <div class="command-buttons">
    {#if !game && app.live.match?.party.state.toLowerCase() === 'waiting'}
      <p class="control-note">The party is waiting. No live action is available yet.</p>
    {:else if !game && app.matchLive}
      <button disabled={!app.gameplayEnabled || app.live.inFlight !== null} type="button" onclick={() => app.live.send({ type: 'start-proximo' })}>{app.live.inFlight?.command.type === 'start-proximo' ? 'Setting up question…' : 'Start first question →'}</button>
    {:else if game && !revealed && !app.gameReady && app.matchLive}
      {#if app.live.inFlight?.command.type === 'ready'}<p class="control-note" role="status">Opening the question…</p>
      {:else if app.autoReadyKey === readyKey}<button disabled={!app.gameplayEnabled || app.live.inFlight !== null} type="button" onclick={() => app.live.send({ type: 'ready', gameId: game.id })}>Retry opening question</button>
      {:else}<p class="control-note" role="status">Question setup is synchronizing…</p>{/if}
    {:else if game && revealed && app.matchLive && app.live.match?.party.state.toLowerCase() === 'running'}
      <button disabled={!app.gameplayEnabled || app.live.inFlight !== null} type="button" onclick={() => app.live.send({ type: 'next-proximo', gameId: game.id })}>{app.live.inFlight?.command.type === 'next-proximo' ? 'Adding question…' : 'Start next question →'}</button>
    {/if}
  </div>
  {#if game && questionActive}
    <div class="answer-grid">
      {#each sides as side}
        <label>Team {side.toUpperCase()} answer
          {#if locallyLocked[side]}<span class="submitted-note">{submitted[side] ? 'Submitted' : 'Sending…'}</span>{:else if unresolved.length === 1}<span class="unresolved-note">Still needed</span>{/if}
          <input disabled={locallyLocked[side] || !app.gameplayEnabled || app.live.inFlight !== null || answeringClosed} type="number" min="0" step="1" inputmode="numeric"
            value={locallyLocked[side] ? '' : app.answers[side]} oninput={(event) => app.answers = { ...app.answers, [side]: event.currentTarget.value }} />
        </label>
      {/each}
      {#if answeringClosed}<p class="answer-closed" role="status">Answering is closed for this question.</p>{/if}
      <button class="lock-both" disabled={!ready.length || !app.gameplayEnabled || app.live.inFlight !== null || answeringClosed} type="button" onclick={() => app.submitAnswers()}>
        {answeringClosed ? 'Answering closed' : app.live.inFlight?.command.type === 'answers' ? 'Locking answers…' : !unresolved.length ? 'Both answers locked' : ready.length === 1 ? `Lock Team ${ready[0].toUpperCase()} answer` : 'Lock both answers'}
      </button>
    </div>
  {/if}
  {#if app.matchLive}<button class="finish-action" disabled={!app.gameplayEnabled || app.live.inFlight !== null} type="button" onclick={() => app.finishMatch()}>End match</button>
  {:else}<p class="terminal-note">This match is closed. Its result remains in History.</p>{/if}
</section>
