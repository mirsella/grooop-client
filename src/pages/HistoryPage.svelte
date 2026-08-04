<script lang="ts">
  import type { AppState } from '../lib/app-state.svelte'
  import { isCancellableMatch, isResumableMatch } from '../lib/domain'
  import type { Match } from '../api'
  let { state }: { state: AppState } = $props()
  const groups = $derived([
    { title: 'Active matches', items: state.activeMatches },
    { title: 'Past matches', items: state.pastMatches },
  ].filter((group) => group.items.length))
  const description = (match: Match) => match.gameMode === 'ttmc'
    ? `TTMC · ${match.rounds} topics · ${match.ttmcContentSlugs.join(' · ')}`
    : `Proximo ${match.contentSlug} · ${match.durationMinutes} minutes`
</script>

<section class="page history-page" aria-labelledby="history-title">
  <div class="hero-copy compact"><p class="kicker">After the noise</p><h1 id="history-title">THE <i>RECORD</i></h1></div>
  {#if state.historyError}<p class="api-error" role="alert">{state.historyError}</p>{/if}
  {#if state.historyLoading}
    <p class="loading">Opening the match ledger…</p>
  {:else if !state.matches.length}
    <div class="history-note"><span>0</span><div><h2>No matches yet.</h2><p>The first game will leave its paper trail here.</p></div></div>
  {:else}
    {#each groups as group}
      <section class="match-group" aria-label={group.title}>
        <h2>{group.title}</h2>
        <ol class="match-list">
          {#each group.items as match, index}
            <li>
              <div class="match-number">{String(index + 1).padStart(2, '0')}</div>
              <div>
                <span class="match-status">{match.status}</span>
                <h3>{match.teamA.name} <i>vs</i> {match.teamB.name}</h3>
                <p>{description(match)} · {match.cost} grooopies</p>
                <time datetime={match.createdAt}>{new Date(match.createdAt).toLocaleString()}</time>
                {#if match.error}<p class="match-error">{match.error}</p>{/if}
              </div>
              {#if isResumableMatch(match)}
                <div class="match-actions">
                  <button type="button" disabled={state.resumingMatchId !== null || state.cancellingMatchId !== null} onclick={() => state.resumeAndOpen(match)}>
                    {state.resumingMatchId === match.id ? 'Resuming…' : match.status.toLowerCase() === 'joining' ? 'Resume setup →' : 'Open live →'}
                  </button>
                  {#if isCancellableMatch(match)}
                    <button class="cancel-match" type="button" disabled={state.resumingMatchId !== null || state.cancellingMatchId !== null} onclick={() => state.cancelActiveMatch(match)}>
                      {state.cancellingMatchId === match.id ? 'Cancelling…' : 'Cancel match'}
                    </button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      </section>
    {/each}
  {/if}
  {#if state.questions?.length}
    <section class="question-history" aria-labelledby="question-history-title">
      <header><p class="kicker">Seen in play</p><h2 id="question-history-title">Question archive</h2></header>
      <ol>
        {#each state.questions as item}
          <li><div><span>{item.content}{item.category ? ` / ${item.category}` : ''}</span><time datetime={item.firstSeenAt}>{new Date(item.firstSeenAt).toLocaleString()}</time></div><h3>{item.question}</h3><p>Answer: <b>{item.answer}</b></p></li>
        {/each}
      </ol>
    </section>
  {/if}
</section>
