<script lang="ts">
  import type { AppState } from '../lib/app-state.svelte'
  import { sides } from '../lib/domain'
  import ProximoBoard from '../game/ProximoBoard.svelte'
  import TtmcBoard from '../game/TtmcBoard.svelte'
  let { state }: { state: AppState } = $props()
</script>

<section class="page match-page" aria-labelledby="match-title">
  <div class="hero-copy compact"><p class="kicker">Grooop / live desk</p><h1 id="match-title">ON <i>THE AIR</i></h1></div>
  <p class="sr-only" aria-live="polite" aria-atomic="true">{state.liveAnnouncement}</p>
  {#if !state.currentMatchId}
    <div class="history-note"><span>?</span><div><h2>No match selected.</h2><p>Create a match or open an active one from History.</p><button type="button" class="text-link" onclick={() => state.navigate('play')}>Set up a match →</button></div></div>
  {:else}
    <div class="live-strip" aria-live="polite"><span class="socket-dot {state.live.state}" aria-hidden="true"></span><b>{state.live.state === 'open' ? 'Live connection' : state.live.state}</b><span>Match {state.currentMatchId}</span>{#if state.currentMatch}<span>{state.currentMatch.teamA.name} vs {state.currentMatch.teamB.name}</span>{/if}</div>
    {#if state.live.error}<p class="api-error" role="alert">{state.live.error}</p>{/if}
    {#if state.live.retryAvailable}<button class="retry-live" type="button" onclick={state.live.retry}>Retry live connection</button>{/if}
    {#if state.live.result}<p class="command-message" role="status">{state.live.result}</p>{/if}
    {#if state.live.match?.gameMode === 'ttmc' && !state.ttmcGame && state.matchLive && ['waiting', 'running'].includes(state.live.match.party.state.toLowerCase())}
      <button class="retry-live start-topic" type="button" disabled={!state.gameplayEnabled || state.live.inFlight !== null} onclick={() => state.live.send({ type: 'start-ttmc-round' })}>{state.live.inFlight?.command.type === 'start-ttmc-round' ? 'Starting topic…' : 'Start first topic →'}</button>
    {/if}
    {#if !state.live.match}
      <div class="match-ticket"><span>CONNECTING / {state.currentMatch?.status ?? 'MATCH'}</span><b>{state.currentMatch?.teamA.name ?? 'TEAM A'} <i>vs</i> {state.currentMatch?.teamB.name ?? 'TEAM B'}</b><p>The live desk will appear as soon as the match socket sends its first state.</p></div>
    {:else}
      <div class="live-layout">
        <section class="panel party-board" aria-labelledby="party-title">
          <header class="panel-heading"><span>01</span><h2 id="party-title">Party floor</h2></header>
          <dl class="state-list"><div><dt>Match</dt><dd>{state.live.match.status}</dd></div><div><dt>Party</dt><dd>{state.live.match.party.state}</dd></div><div><dt>Players</dt><dd>{state.live.match.party.playerCount}</dd></div><div><dt>Connected</dt><dd>{state.live.match.connected ? 'Yes' : 'No'}</dd></div></dl>
          <div class="team-live">{#each sides as side}<article class="side-{side}"><span>{side.toUpperCase()}</span><h3>{state.live.match.teams[side].name}</h3><p>{state.live.match.teams[side].roster.join(' · ')}</p></article>{/each}</div>
          <details><summary>Player state</summary><ul class="player-list">{#each state.live.match.players as player, index}<li><b>Player {player.id ?? index + 1}</b><span>{player.isGameMaster ? 'Game master' : 'Player'} · {player.isConnected ? 'connected' : 'offline'} · {player.score === null ? 'score hidden' : `${player.score} pts`}</span></li>{/each}</ul></details>
        </section>
        {#if state.live.match.gameMode === 'ttmc'}<TtmcBoard {state} />{:else}<ProximoBoard {state} />{/if}
      </div>
    {/if}
  {/if}
</section>
