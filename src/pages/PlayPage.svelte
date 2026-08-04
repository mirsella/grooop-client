<script lang="ts">
  import { content, lowestBalanceSide, sides, type ContentSlug, type Side } from '../lib/domain'
  import type { AppState } from '../lib/app-state.svelte'

  let { state }: { state: AppState } = $props()

  function value(event: Event) { return (event.currentTarget as HTMLInputElement | HTMLSelectElement).value }
  function setAccount(side: Side, accountId: string) {
    state.editDraft((draft) => {
      const accountIds = { ...draft.accountIds, [side]: accountId }
      return { ...draft, accountIds, host: lowestBalanceSide(accountIds, state.activeAccounts, draft.host) }
    })
  }
  function setTeamName(side: Side, name: string) {
    state.editDraft((draft) => ({ ...draft, teams: { ...draft.teams, [side]: { ...draft.teams[side], name } } }))
  }
</script>

<section class="page" aria-labelledby="play-title">
  <div class="hero-copy">
    <p class="kicker">Set the table / pick your sides</p>
    <h1 id="play-title">LET’S <i>PLAY</i></h1>
    <p>One phone. Two teams. A round worth arguing about.</p>
  </div>
  <p class="setup-memory" role="status">Lineup and game setup save automatically on this device.</p>

  {#if state.initialRestoreState === 'loading'}
    <p class="restore-note" role="status">Checking for an active match before opening the match desk…</p>
  {:else if state.initialRestoreState === 'error'}
    <div class="restore-error" role="alert">
      <b>Active-match check failed.</b> {state.initialRestoreError}
      <button type="button" onclick={() => state.restoreInitialMatch()}>Retry active-match check</button>
    </div>
  {/if}
  {#if state.accountError}<p class="api-error" role="alert">{state.accountError}</p>{/if}

  <div class="setup-grid">
    <section class="panel accounts-panel" aria-labelledby="lineup-title">
      <header class="panel-heading"><span>01</span><h2 id="lineup-title">The lineup</h2></header>
      {#if state.accounts === null || state.loadingAccounts}
        <div class="empty-state">
          <strong>{state.loadingAccounts ? 'Checking the guest list…' : 'Account setup is unavailable.'}</strong>
          <p>{state.loadingAccounts ? 'Hold the draw until the account list arrives.' : 'Reload accounts in Settings before creating a match.'}</p>
        </div>
      {:else if state.activeAccounts.length < 2}
        <div class="empty-state">
          <strong>Two active accounts needed.</strong>
          <p>Add or refresh accounts in Settings before dealing teams.</p>
          <button type="button" class="text-link" onclick={() => state.navigate('settings')}>Go to settings →</button>
        </div>
      {:else}
        <div class="team-picks">
          {#each sides as side}
            <label>Team {side.toUpperCase()} account
              <select disabled={state.setupLocked} value={state.draft.accountIds[side]} onchange={(event) => setAccount(side, value(event))}>
                {#each state.activeAccounts as account}
                  <option value={account.id} disabled={account.id === state.draft.accountIds[side === 'a' ? 'b' : 'a']}>{account.email}</option>
                {/each}
              </select>
            </label>
          {/each}
        </div>
        <label class="host-pick">Host
          <select disabled={state.setupLocked} value={state.draft.host} onchange={(event) => state.editDraft((draft) => ({ ...draft, host: value(event) as Side }))}>
            {#each sides as side}<option value={side}>Team {side.toUpperCase()} · {state.selectedAccounts[side]?.email}</option>{/each}
          </select>
        </label>
      {/if}
    </section>

    <section class="panel teams-panel" aria-labelledby="teams-title">
      <header class="panel-heading"><span>02</span><h2 id="teams-title">Name your sides</h2></header>
      {#if state.presetError}<p class="api-error" role="alert">{state.presetError}</p>{/if}
      <div class="team-names">
        {#each sides as side, index}
          <label><span class="side-token side-{side}">{side.toUpperCase()}</span>
            <input disabled={state.setupLocked} maxlength="40" value={state.draft.teams[side].name}
              oninput={(event) => setTeamName(side, value(event))} aria-label={`Team ${side.toUpperCase()} name`} />
          </label>
          {#if index === 0}<strong>VS</strong>{/if}
        {/each}
      </div>
      <div class="roster-columns">
        {#each sides as side}
          <fieldset class="roster" disabled={state.setupLocked}>
            <legend>Team {side.toUpperCase()} roster</legend>
            <div class="preset-picker">
              <label>Saved team
                <select value={state.presetSelections[side]} disabled={state.presets === null || state.presetBusy !== null}
                  onchange={(event) => state.presetSelections = { ...state.presetSelections, [side]: value(event) }}>
                  <option value="">New preset</option>
                  {#each state.presets ?? [] as preset}<option value={preset.id}>{preset.name}</option>{/each}
                </select>
              </label>
              <div class="preset-actions">
                <button type="button" disabled={!state.presetSelections[side] || state.presetBusy !== null} onclick={() => state.applyPreset(side)}>Apply</button>
                <button type="button" disabled={state.presetBusy !== null || !state.cleanedTeams[side].name || !state.cleanedTeams[side].roster.length} onclick={() => state.savePreset(side)}>
                  {state.presetBusy === `save-${side}` ? 'Saving…' : state.presetSelections[side] ? 'Update' : 'Save'}
                </button>
                <button class="preset-delete" type="button" disabled={!state.presetSelections[side] || state.presetBusy !== null} onclick={() => state.removePreset(side)}>
                  {state.presetBusy === `delete-${side}` ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
            {#each state.draft.teams[side].roster as player, index}
              <div class="roster-row">
                <label><span>{String(index + 1).padStart(2, '0')}</span>
                  <input required maxlength="40" value={player} aria-label={`Team ${side.toUpperCase()} player ${index + 1}`}
                    oninput={(event) => state.editRoster(side, 'set', index, value(event))} />
                </label>
                <button type="button" disabled={state.draft.teams[side].roster.length === 1} aria-label={`Remove Team ${side.toUpperCase()} player ${index + 1}`}
                  onclick={() => state.editRoster(side, 'remove', index)}>×</button>
              </div>
            {/each}
            <button class="add-player text-link" type="button" disabled={state.draft.teams[side].roster.length >= 12} onclick={() => state.editRoster(side, 'add')}>+ Add player</button>
          </fieldset>
        {/each}
      </div>
    </section>

    <section class="panel pack-panel" aria-labelledby="pack-title">
      <header class="panel-heading"><span>03</span><h2 id="pack-title">Choose the game</h2></header>
      <div class="mode-options">
        {#each [{ mode: 'proximo' as const, title: 'Proximo', copy: 'Timed number guesses' }, { mode: 'ttmc' as const, title: 'TTMC', copy: 'Choose your own difficulty' }] as option}
          <label class:selected={state.draft.gameMode === option.mode}>
            <input disabled={state.setupLocked} type="radio" name="game-mode" checked={state.draft.gameMode === option.mode}
              onchange={() => state.editDraft((draft) => ({ ...draft, gameMode: option.mode }))} />
            <b>{option.title}</b><span>{option.copy}</span>
          </label>
        {/each}
      </div>

      {#if state.draft.gameMode === 'proximo'}
        <div class="pack-options">
          {#each content as [slug, title, description]}
            <label class:selected={state.draft.contentSlug === slug}>
              <input disabled={state.setupLocked} type="radio" name="pack" value={slug} checked={state.draft.contentSlug === slug}
                onchange={() => state.editDraft((draft) => ({ ...draft, contentSlug: slug as ContentSlug }))} />
              <b>{title}</b><span>{description}</span>
            </label>
          {/each}
        </div>
        <label class="duration">Round duration
          <select disabled={state.setupLocked} value={state.draft.durationMinutes}
            onchange={(event) => state.editDraft((draft) => ({ ...draft, durationMinutes: Number(value(event)) }))}>
            <option value="15">15 minutes</option><option value="30">30 minutes</option><option value="45">45 minutes</option>
          </select>
        </label>
      {:else}
        <div class="ttmc-config">
          <fieldset class="ttmc-packs">
            <legend>TTMC packs</legend>
            {#if state.ttmcCatalogLoading}<p class="loading">Loading the host’s TTMC packs…</p>{/if}
            {#if state.ttmcCatalogError}
              <div class="api-error" role="alert"><p>{state.ttmcCatalogError}</p><button class="retry-live" type="button" onclick={() => state.loadTtmcCatalog()}>Retry loading TTMC packs</button></div>
            {/if}
            {#if state.readyTtmcCatalog && !state.readyTtmcCatalog.owned}<p class="api-error" role="alert">The selected host does not own TTMC.</p>{/if}
            {#if state.readyTtmcCatalog?.owned && !state.ttmcContents.length}<p class="api-error" role="alert">No TTMC packs are available for the selected host.</p>{/if}
            {#if state.readyTtmcCatalog?.owned && state.ttmcContents.length}
                {#if state.allTtmcContentsSelected}
                  <p class="ttmc-all-packs selected" role="status"><b>All packs selected</b><span>Every available question pack is in play</span></p>
                {:else}
                  <button class="ttmc-all-packs" type="button" disabled={state.setupLocked} onclick={() => state.selectAllTtmcContents()}><b>Select all packs</b><span>Use every available TTMC question pack</span></button>
                {/if}
                <p class="ttmc-selection-help">Select at least one pack to play TTMC.</p>
                {#if !state.ttmcSelectionValid}<p class="api-error" role="alert">Select at least one TTMC pack to price this match.</p>{/if}
                <div class="pack-options">
                  {#each state.ttmcContents as pack}
                    <label class:selected={state.ttmcContentSlugs.includes(pack.slug)}>
                      <input disabled={state.setupLocked} type="checkbox" checked={state.ttmcContentSlugs.includes(pack.slug)} onchange={() => state.toggleTtmcContent(pack.slug)} />
                      <b>{pack.title}</b><span>{pack.slug}</span>
                    </label>
                  {/each}
                </div>
            {/if}
          </fieldset>
          <label class="topic-count"><span class="topic-count-heading">Topics <output for="ttmc-topics" aria-live="polite">{state.draft.rounds}</output></span>
            <input id="ttmc-topics" aria-label="Topics" aria-valuetext={`${state.draft.rounds} topics`} disabled={state.setupLocked || !state.readyTtmcCatalog?.owned || !state.ttmcContents.length || !state.ttmcRounds}
              type="range" min={state.ttmcRounds?.min} max={state.ttmcRounds?.max} step={state.ttmcRounds?.step} value={state.draft.rounds}
              oninput={(event) => state.editDraft((draft) => ({ ...draft, rounds: Number(value(event)) }))} />
            <span class="topic-count-scale" aria-hidden="true"><span>{state.ttmcRounds?.min ?? '–'}</span><span>{state.ttmcRounds?.max ?? '–'}</span></span>
          </label>
        </div>
      {/if}
    </section>
  </div>

  <section class="cost-card" aria-label="Match quote">
    <div class="match-summary">
      <p class="kicker">Match desk</p>
      <h2>{state.draft.teams.a.name || 'Team A'} <i>vs</i> {state.draft.teams.b.name || 'Team B'}</h2>
      <p>{state.selectedAccounts.a?.email ?? 'Team A account'} / {state.selectedAccounts.b?.email ?? 'Team B account'} · {state.draft.gameMode === 'proximo' ? `${state.draft.durationMinutes} min · Proximo ${state.draft.contentSlug}` : `TTMC · ${state.draft.rounds} topics`}</p>
    </div>
    <div class="cost">
      <span>{state.quote ? 'Exact cost' : 'Cost'}</span>
      <b>{state.quote ? `${state.quote.cost} grooopies` : state.playBusy === 'quote' ? 'Pricing match…' : state.setupValid ? 'Price unavailable' : 'Finish setup'}</b>
      {#if state.quote}<small>Host balance {state.quote.hostBalance} · Guest balance {state.quote.guestBalance}</small>{/if}
      {#if state.quote && !state.quote.userCanSpend}<small class="cost-warning" role="alert">The host balance is too low for this match.</small>{/if}
    </div>
    <p class="sr-only" role="status" aria-live="polite">{state.playBusy === 'quote' ? 'Pricing this match automatically.' : state.quote ? 'Automatic pricing is complete.' : 'Automatic pricing waits for a complete match setup.'}</p>
    <div class="quote-actions">
      <button class="create-button" type="button" disabled={!state.setupValid || !state.quote?.userCanSpend || state.playBusy !== null || state.initialRestoreState !== 'ready'} onclick={() => state.submitMatch()}>
        {state.playBusy === 'create' ? 'Creating match…' : state.quote ? `Create match — ${state.quote.cost} grooopies →` : state.playBusy === 'quote' ? 'Pricing match…' : 'Finish setup'}
      </button>
      {#if !state.quote && state.playError && state.setupValid && state.initialRestoreState === 'ready' && state.playBusy === null}
        <button class="retry-quote" type="button" onclick={state.refreshQuote}>Retry price</button>
      {/if}
    </div>
    {#if state.playError}<p class="cost-error" role="alert">{state.playError}</p>{/if}
    {#if !state.setupValid}<p class="cost-note">{state.ttmcSetupBlocker || 'Choose two accounts, name both teams, and give each side 1 to 12 players.'}</p>{/if}
  </section>
</section>
