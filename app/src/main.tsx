import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { registerServiceWorker } from './registerServiceWorker.ts'

render(<App />, document.getElementById('app')!)
registerServiceWorker()
