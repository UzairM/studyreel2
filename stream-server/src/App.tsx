import { useState, useEffect } from 'react'
import { io } from 'socket.io-client'
import { StreamList } from './components/StreamList'
import { StreamViewer } from './components/StreamViewer'
import './App.css'
import './index.css' // Re-import CSS for good measure

interface Stream {
  id: string
  kind: string
}

function App() {
  const [streams, setStreams] = useState<Stream[]>([])
  const [selectedStream, setSelectedStream] = useState<string | null>(null)

  useEffect(() => {
    const socket = io('http://localhost:3001')

    const fetchStreams = () => {
      socket.emit('getProducers', (producers: Stream[]) => {
        setStreams(producers)
      })
    }

    socket.on('connect', fetchStreams)
    socket.on('producerClosed', fetchStreams)
    socket.on('newProducer', fetchStreams)

    // Fetch streams every 5 seconds
    const interval = setInterval(fetchStreams, 5000)

    return () => {
      clearInterval(interval)
      socket.disconnect()
    }
  }, [])

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      {/* Test element to verify Tailwind is working */}
      <div className="p-8 mb-4 bg-red-500 text-white text-3xl font-bold rounded-lg shadow-lg">
        This should be visible if Tailwind is working
      </div>
      
      {selectedStream ? (
        <StreamViewer
          streamId={selectedStream}
          onBack={() => setSelectedStream(null)}
        />
      ) : (
        <StreamList
          streams={streams}
          onStreamSelect={setSelectedStream}
        />
      )}
    </div>
  )
}

export default App
