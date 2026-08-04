<script lang="ts">
  import type { Side } from '../lib/domain'
  import type { TtmcAnswer, TtmcQuestion } from '../api'
  let { side, question, disabled, answer = $bindable() }: {
    side: Side
    question: TtmcQuestion
    disabled: boolean
    answer?: TtmcAnswer
  } = $props()
</script>

<fieldset class="ttmc-answer-controls">
  <legend class="sr-only">Team {side.toUpperCase()} answer controls</legend>
  {#if question.type === 'bool'}
    <div class="choice-row">
      <button type="button" {disabled} aria-pressed={answer === true} onclick={() => answer = true}>Yes</button>
      <button type="button" {disabled} aria-pressed={answer === false} onclick={() => answer = false}>No</button>
    </div>
  {:else if question.type === 'qcm'}
    {@const selected = Array.isArray(answer) ? answer as number[] : []}
    <p class="answer-instruction" role="status">{selected.length >= question.selectionCount ? `Selected ${question.selectionCount}. Deselect one to change.` : `Choose ${question.selectionCount}`}</p>
    <div class="choice-row">
      {#each question.options as option, index}
        {@const chosen = Array.isArray(answer) && answer.includes(index)}
        <button type="button" disabled={disabled || (!chosen && selected.length >= question.selectionCount)} aria-pressed={chosen} onclick={() => {
          answer = chosen ? selected.filter((item) => item !== index) : [...selected, index]
        }}>{option}</button>
      {/each}
    </div>
  {:else if question.type === 'number'}
    <label>Answer
      <input aria-label={`Team ${side.toUpperCase()} answer`} type="range" min={question.min} max={question.max} step={question.step}
        {disabled} value={typeof answer === 'number' ? answer : question.min}
        oninput={(event) => answer = Number(event.currentTarget.value)} />
      <b>{typeof answer === 'number' ? answer : question.min}</b>
    </label>
  {:else if question.type === 'oneword'}
    <input aria-label={`Team ${side.toUpperCase()} answer`} {disabled} value={typeof answer === 'string' ? answer : ''}
      oninput={(event) => answer = event.currentTarget.value} />
  {:else}
    <p class="answer-instruction">Build a {question.answerWordCount}-word answer</p>
    <div class="choice-row">
      {#each question.candidates as word}
        {@const words = Array.isArray(answer) ? answer as string[] : []}
        {@const used = words.filter((item) => item === word).length}
        {@const available = question.candidates.filter((item) => item === word).length}
        <button type="button" disabled={disabled || words.length >= question.answerWordCount || used >= available}
          onclick={() => answer = [...words, word]}>{word}</button>
      {/each}
    </div>
    <p class="word-answer">
      {#each Array.isArray(answer) ? answer as string[] : [] as word, index}
        <button type="button" {disabled} onclick={() => answer = (answer as string[]).filter((_, itemIndex) => itemIndex !== index)}>{word} ×</button>
      {/each}
    </p>
  {/if}
</fieldset>
