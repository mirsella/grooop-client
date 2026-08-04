import { mount } from 'svelte'
import App from './App.svelte'
import './index.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'))
}

const target = document.getElementById('app')
if (!target) throw new Error('The Svelte application mount point is missing.')

mount(App, { target })
