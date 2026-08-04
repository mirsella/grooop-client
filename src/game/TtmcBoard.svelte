<script lang="ts">
  import type { AppState } from '../lib/app-state.svelte'
  import { isCompleteTtmcAnswer, sides, ttmcAnswerValue, ttmcTurnOrder, type Side } from '../lib/domain'
  import TtmcAnswerControls from './TtmcAnswerControls.svelte'
  let { state }: { state: AppState } = $props()
  const game = $derived(state.ttmcGame)
  const order = $derived(game ? ttmcTurnOrder(game.roundNumber) : ['a', 'b'] as [Side, Side])
  const active = $derived(state.activeTtmcTeam)
  const finalRound = $derived(game !== null && game.roundNumber >= game.totalRounds)
  const activeQuestion = $derived(game && active ? game.teams[active].question : null)
  const answerReady = $derived(activeQuestion && active ? isCompleteTtmcAnswer(activeQuestion, ttmcAnswerValue(activeQuestion, state.ttmcAnswers[active])) : false)
</script>

<section class="panel game-board" aria-labelledby="game-title">
  <header class="panel-heading"><span>02</span><h2 id="game-title">TTMC</h2></header>
  {#if !game}
    <div class="empty-state"><strong>{state.live.match?.party.state.toLowerCase() === 'waiting' ? 'Ready to start the first topic.' : 'No topic in play.'}</strong></div>
    {#if state.matchLive && ['waiting', 'running'].includes(state.live.match?.party.state.toLowerCase() ?? '')}
      <button class="retry-live" type="button" disabled={state.gameplayDraftDisabled} onclick={() => state.live.send({ type: 'start-ttmc-round' })}>{state.live.inFlight?.command.type === 'start-ttmc-round' ? 'Starting topic…' : 'Start first topic →'}</button>
    {/if}
  {:else}
    <div class="game-meta"><span>{game.category ?? 'Category pending'}</span><span>Topic {game.roundNumber} / {game.totalRounds}</span></div>
    <h3>{game.title ?? 'Choose a difficulty to begin.'}</h3>
    <div class:complete={game.state === 'finished'} class="ttmc-next-step" role="status">
      <span>What happens now</span>
      {#if !state.gameplayEnabled && state.matchLive}
        <h4>Reconnecting to the game…</h4><p>Keep this screen open. The current turn will unlock automatically.</p>
      {:else if game.state === 'finished'}
        {#if finalRound}
          <h4>All topics are complete.</h4><p>Both teams are finished. Waiting for Grooop to close the match.</p>
        {:else}
          <h4>Topic complete. Start a fresh topic.</h4><p>Both teams answered this topic. The next topic starts with Team {ttmcTurnOrder(game.roundNumber + 1)[0].toUpperCase()}.</p>
          {#if state.matchLive && state.live.match?.party.state.toLowerCase() === 'running'}
            <button type="button" disabled={state.live.inFlight !== null} onclick={() => state.live.send({ type: 'next-ttmc-round', roundId: game.id })}>{state.live.inFlight?.command.type === 'next-ttmc-round' ? 'Starting next topic…' : 'Start next topic →'}</button>
          {:else}<p>Waiting for the party before the next topic can start.</p>{/if}
        {/if}
      {:else if game.state === 'unknown'}
        <h4>Synchronizing this topic…</h4><p>No action is needed. The current turn will appear automatically.</p>
      {:else if !active}
        <h4>Both answers are locked.</h4><p>Waiting for Grooop to score this topic. No action is needed.</p>
      {:else if game.teams[active].difficulty === null}
        <h4>Team {active.toUpperCase()} chooses its level.</h4><p>Rate your own team from 1 to 10 below. Both teams play this same topic before moving on.</p>
      {:else if game.teams[active].question === null}
        <h4>Opening Team {active.toUpperCase()}’s question…</h4><p>No action is needed. The question will appear here automatically.</p>
      {:else}
        <h4>Team {active.toUpperCase()} answers now.</h4><p>The other team reads the question aloud. Choose an answer, then lock it below.</p>
      {/if}
    </div>
    <ol class="ttmc-turn-rail" aria-label="Topic turn order">
      {#each order as side, index}
        {@const done = game.teams[side].submitted}
        <li class="side-{side}" class:done class:active={side === active}>
          <span>Turn {index + 1}</span><b>{state.live.match?.teams[side].name}</b><em>{done ? 'Done' : side === active ? 'Up now' : 'Waiting'}</em>
        </li>
      {/each}
    </ol>
    <div class="ttmc-teams">
      {#each game.state === 'finished' ? sides : active ? [active] : [] as side}
        {@const team = game.teams[side]}
        {@const reader = side === 'a' ? 'b' : 'a'}
        {@const finished = game.state === 'finished' && team.success !== null}
        <article class="ttmc-team side-{side}">
          <span>{finished ? `TEAM ${side.toUpperCase()} RESULT` : `TURN ${order.indexOf(side) + 1} OF 2 · TEAM ${side.toUpperCase()}`}</span>
          <h4>{state.live.match?.teams[side].name}</h4>
          {#if team.difficulty === null && game.state === 'running'}
            <div class="ttmc-rating">
              <p><b>How well does your team know this topic?</b>Higher numbers mean a harder question worth more.</p>
              <fieldset class="difficulty-grid"><legend class="sr-only">Team {side.toUpperCase()} difficulty</legend>
                {#each Array.from({ length: 10 }, (_, index) => index + 1) as difficulty}
                  <button type="button" disabled={state.gameplayDraftDisabled} aria-pressed={state.ttmcDifficulties[side] === difficulty}
                    onclick={() => state.ttmcDifficulties[side] = difficulty}>{difficulty}</button>
                {/each}
              </fieldset>
              <div class="difficulty-readout"><b>{state.ttmcDifficulties[side]} / 10</b><span>{state.ttmcDifficulties[side] <= 3 ? 'Safe bet' : state.ttmcDifficulties[side] <= 6 ? 'Confident' : state.ttmcDifficulties[side] <= 8 ? 'Bold' : 'All in'}</span></div>
              <button class="difficulty-lock" type="button" disabled={!state.matchLive || state.gameplayDraftDisabled || game.state !== 'running'} onclick={() => state.startTtmcQuestion(side)}>Lock in {state.ttmcDifficulties[side]} for Team {side.toUpperCase()} →</button>
            </div>
          {:else}
            <p>Difficulty {team.difficulty ?? '—'} / 10</p>
            {#if team.question && !team.submitted}
              <div class="ttmc-question"><p class="reader-handoff"><b>Team {reader.toUpperCase()}, read this aloud.</b>Team {side.toUpperCase()} gives the final answer.</p><b>{team.question.prompt}</b><TtmcAnswerControls {side} question={team.question} disabled={state.gameplayDraftDisabled} bind:answer={state.ttmcAnswers[side]} /></div>
            {/if}
            {#if team.submitted && !finished}<p class="submitted-note">Submitted</p>{/if}
            {#if finished}
              <div class="official-answer"><span>{team.success ? 'Correct' : 'Incorrect'} · {team.points ?? 0} points</span><b>{Array.isArray(team.officialAnswer) ? team.officialAnswer.join(' · ') : typeof team.officialAnswer === 'object' && team.officialAnswer ? `${team.officialAnswer.value} ± ${team.officialAnswer.tolerance}` : team.officialAnswer ?? 'No official answer'}</b></div>
            {/if}
          {/if}
        </article>
      {/each}
      {#if game.state === 'running' && !active}<p class="waiting-note" role="status">Both turns are locked. Waiting for the topic result.</p>{/if}
    </div>
  {/if}
</section>

{#if game}
  <section class="control-deck ttmc-controls" aria-labelledby="controls-title">
    <div><p class="kicker">Make the call</p><h2 id="controls-title">Controls</h2></div>
    {#if game.state === 'running'}
      <button class="lock-both" type="button" disabled={state.gameplayDraftDisabled || !answerReady} onclick={() => state.submitTtmcAnswers()}>
        {state.live.inFlight?.command.type === 'ttmc-answers' ? 'Locking answers…' : active ? `Lock Team ${active.toUpperCase()} answer` : 'Both turns locked'}
      </button>
    {/if}
    {#if !state.matchLive}<p class="terminal-note">This match is closed. Its result remains in History.</p>{/if}
  </section>
{/if}
