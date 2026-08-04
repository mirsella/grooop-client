<script lang="ts">
  import type { AppState } from '../lib/app-state.svelte'
  import type { Side } from '../lib/domain'
  import type { TtmcQuestion } from '../api'
  let { state, side, question }: { state: AppState; side: Side; question: TtmcQuestion } = $props()
  const answer = $derived(state.ttmcAnswers[side])
  const setAnswer = (value: boolean | number | string | Array<string | number>) => state.ttmcAnswers = { ...state.ttmcAnswers, [side]: value }
</script>

<fieldset class="ttmc-answer-controls">
  <legend class="sr-only">Team {side.toUpperCase()} answer controls</legend>
  {#if question.type === 'bool'}
    <div class="choice-row">
      <button type="button" disabled={state.gameplayDraftDisabled} aria-pressed={answer === true} onclick={() => setAnswer(true)}>Yes</button>
      <button type="button" disabled={state.gameplayDraftDisabled} aria-pressed={answer === false} onclick={() => setAnswer(false)}>No</button>
    </div>
  {:else if question.type === 'qcm'}
    {@const selected = Array.isArray(answer) ? answer as number[] : []}
    <p class="answer-instruction" role="status">{selected.length >= question.selectionCount ? `Selected ${question.selectionCount}. Deselect one to change.` : `Choose ${question.selectionCount}`}</p>
    <div class="choice-row">
      {#each question.options as option, index}
        {@const chosen = Array.isArray(answer) && answer.includes(index)}
        <button type="button" disabled={state.gameplayDraftDisabled || (!chosen && selected.length >= question.selectionCount)} aria-pressed={chosen} onclick={() => {
          setAnswer(chosen ? selected.filter((item) => item !== index) : selected.length < question.selectionCount ? [...selected, index] : selected)
        }}>{option}</button>
      {/each}
    </div>
  {:else if question.type === 'number'}
    <label>Answer
      <input aria-label={`Team ${side.toUpperCase()} answer`} type="range" min={question.min} max={question.max} step={question.step}
        disabled={state.gameplayDraftDisabled} value={typeof answer === 'number' ? answer : question.min}
        oninput={(event) => setAnswer(Number(event.currentTarget.value))} />
      <b>{typeof answer === 'number' ? answer : question.min}</b>
    </label>
  {:else if question.type === 'oneword'}
    <input aria-label={`Team ${side.toUpperCase()} answer`} disabled={state.gameplayDraftDisabled} value={typeof answer === 'string' ? answer : ''}
      oninput={(event) => setAnswer(event.currentTarget.value)} />
  {:else}
    <p class="answer-instruction">Build a {question.answerWordCount}-word answer</p>
    <div class="choice-row">
      {#each question.candidates as word}
        {@const words = Array.isArray(answer) ? answer as string[] : []}
        {@const used = words.filter((item) => item === word).length}
        {@const available = question.candidates.filter((item) => item === word).length}
        <button type="button" disabled={state.gameplayDraftDisabled || words.length >= question.answerWordCount || used >= available}
          onclick={() => setAnswer([...words, word])}>{word}</button>
      {/each}
    </div>
    <p class="word-answer">
      {#each Array.isArray(answer) ? answer as string[] : [] as word, index}
        <button type="button" disabled={state.gameplayDraftDisabled} onclick={() => setAnswer((answer as string[]).filter((_, itemIndex) => itemIndex !== index))}>{word} ×</button>
      {/each}
      <button type="button" disabled={state.gameplayDraftDisabled} onclick={() => setAnswer([])}>Clear</button>
    </p>
  {/if}
</fieldset>
