<script lang="ts">
  import type { AppState } from '../lib/app-state.svelte'
  import { isActive } from '../lib/domain'
  let { state }: { state: AppState } = $props()
</script>

<section class="page" aria-labelledby="settings-title">
  <div class="hero-copy compact">
    <p class="kicker">Keep the cupboard stocked</p>
    <h1 id="settings-title">YOUR <i>ACCOUNTS</i></h1>
  </div>
  {#if state.accountError}<p class="api-error" role="alert">{state.accountError}</p>{/if}
  <div class="settings-grid">
    <section class="panel" aria-labelledby="accounts-title">
      <header class="panel-heading"><span>01</span><h2 id="accounts-title">Connected accounts</h2></header>
      {#if state.loadingAccounts}
        <p class="loading">Checking the guest list…</p>
      {:else if state.accounts === null}
        <div class="empty-state"><strong>Account list unavailable.</strong><button type="button" class="text-link" onclick={() => state.loadAccounts()}>Try again →</button></div>
      {:else if !state.accounts.length}
        <p class="loading">No accounts yet. Add one to start.</p>
      {:else}
        <ul class="account-list">
          {#each state.accounts as account}
            <li>
              <div><b>{account.email}</b><span class:active={isActive(account)} class="status">{account.status} · {account.grooopies} grooopies</span></div>
              <div class="account-actions">
                {#if isActive(account)}
                  <button type="button" disabled={state.accountBusy !== null} onclick={() => state.updateAccount(account.id, 'refresh')}>{state.accountBusy === `refresh-${account.id}` ? 'Refreshing…' : 'Refresh'}</button>
                {:else}
                  <button type="button" disabled={state.accountBusy !== null} onclick={() => state.startReauthentication(account.id)}>{state.accountBusy === `reauthenticate-${account.id}` ? 'Sending…' : 'Re-authenticate'}</button>
                {/if}
                <button class="danger" type="button" disabled={state.accountBusy !== null} onclick={() => state.updateAccount(account.id, 'remove')}>{state.accountBusy === `remove-${account.id}` ? 'Removing…' : 'Remove'}</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
    <section class="panel add-account" aria-labelledby="add-title">
      <header class="panel-heading"><span>02</span><h2 id="add-title">{state.challenge ? 'Verify an account' : 'Add an account'}</h2></header>
      {#if !state.challenge}
        <form onsubmit={(event) => state.requestCode(event)}>
          <label>Email address<input type="email" required bind:value={state.email} placeholder="team@example.com" autocomplete="email" /></label>
          <button class="primary" type="submit" disabled={state.accountBusy !== null}>{state.accountBusy === 'challenge' ? 'Sending code…' : 'Send verification code →'}</button>
        </form>
      {:else}
        <form onsubmit={(event) => state.confirmCode(event)}>
          <p class="code-sent">Code sent to <b>{state.challenge.email}</b>. Check the inbox, then enter it below.</p>
          <label>Verification code
            <input required minlength="8" maxlength="8" pattern="[A-Z0-9]{8}" title="Enter the 8-character uppercase code" value={state.code}
              oninput={(event) => state.code = event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}
              inputmode="text" autocapitalize="characters" autocomplete="one-time-code" placeholder="AB12CD34" />
          </label>
          <button class="primary" type="submit" disabled={state.accountBusy !== null}>{state.accountBusy === 'verify' ? 'Verifying…' : 'Verify account →'}</button>
          <button class="text-link" type="button" onclick={() => state.challenge = null}>Use a different email</button>
        </form>
      {/if}
    </section>
  </div>
</section>
