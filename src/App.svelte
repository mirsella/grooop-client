<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { AppState } from './lib/app-state.svelte'
  import type { Tab } from './lib/domain'
  import PlayPage from './pages/PlayPage.svelte'
  import MatchPage from './pages/MatchPage.svelte'
  import HistoryPage from './pages/HistoryPage.svelte'
  import SettingsPage from './pages/SettingsPage.svelte'
  import './App.css'

  const app = new AppState()
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'play', label: 'Play' },
    { id: 'match', label: 'Match' },
    { id: 'history', label: 'History' },
    { id: 'settings', label: 'Settings' },
  ]

  onMount(() => {
    void app.init()
    return () => app.destroy()
  })

  $effect(() => {
    void [app.setupSignature, app.setupValid, app.initialRestoreState]
    untrack(() => app.scheduleQuote())
  })

  $effect(() => {
    void [app.draft.gameMode, app.ttmcHostAccountId]
    untrack(() => void app.loadTtmcCatalog())
  })

  $effect(() => {
    void [app.live.match, app.live.inFlight, app.live.state, app.live.matchId]
    untrack(() => app.syncLiveEffects())
  })
</script>

<main class="app-shell" id="top">
  <header class="masthead">
    <a class="brand" href="#top" aria-label="Grooop Client home" onclick={() => app.navigate('play')}>
      <span class="brand-mark" aria-hidden="true">G</span>
      <span>grooop<small>game night</small></span>
    </a>
    <p class="eyebrow">One phone <i></i> Two teams <i></i> No mercy</p>
    <span class="issue">NIGHT<br />01</span>
  </header>
  <nav class="tabbar" aria-label="Game sections">
    {#each tabs as item, index}
      <button type="button" class:active={app.tab === item.id} onclick={() => app.navigate(item.id)} aria-current={app.tab === item.id ? 'page' : undefined}>
        <span>0{index + 1}</span>{item.label}
      </button>
    {/each}
  </nav>

  <div class="page-stage">
    {#if app.tab === 'play'}<PlayPage state={app} />
    {:else if app.tab === 'match'}<MatchPage state={app} />
    {:else if app.tab === 'history'}<HistoryPage state={app} />
    {:else}<SettingsPage state={app} />{/if}
  </div>
</main>
