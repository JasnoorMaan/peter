import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles.css'

// StrictMode mounts twice and would open, then immediately drop, the LiveKit room.
createRoot(document.getElementById('root')!).render(<App />)
