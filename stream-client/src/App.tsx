import React, { useState, useEffect } from 'react';
import { Container, Grid, Box, Typography, CircularProgress, Alert, Button } from '@mui/material';
import { ConnectionForm } from './components/ConnectionForm';
import { Chat } from './components/Chat';
import { WebRTCService } from './services/WebRTCService';
import { StreamConfig, ChatMessage } from './types';

const webRTCService = new WebRTCService();

export const App: React.FC = () => {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [username, setUsername] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamStarted, setStreamStarted] = useState(false);
  const [showCancelButton, setShowCancelButton] = useState(false);

  useEffect(() => {
    webRTCService.setOnChatMessage((message) => {
      setMessages((prev) => [...prev, message]);
    });

    return () => {
      webRTCService.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelTimer: ReturnType<typeof setTimeout>;
    
    if (connecting) {
      cancelTimer = setTimeout(() => {
        setShowCancelButton(true);
      }, 5000);
    } else {
      setShowCancelButton(false);
    }
    
    return () => {
      clearTimeout(cancelTimer);
    };
  }, [connecting]);

  const handleConnect = async (config: StreamConfig) => {
    setConnecting(true);
    setError(null);
    
    try {
      console.log('Connecting to server:', config.serverUrl);
      await webRTCService.connect(config);
      setConnected(true);
      
      console.log('Connection successful, setting up streaming');
      
      // Start video streaming regardless of data channel status
      if (config.videoFile) {
        console.log('Starting video stream with file:', config.videoFile.name);
        await webRTCService.startStreaming(config.videoFile);
        console.log('Video streaming started successfully');
        setStreamStarted(true);
      }
      
      // Setup data channel but don't block on it
      try {
        console.log('Setting up data channel');
        await webRTCService.setupDataChannel();
        console.log('Data channel setup successfully');
      } catch (error) {
        console.error('Data channel setup failed, but continuing with video:', error);
        // Show a warning but don't fail completely
        setError('Chat functionality not available, but streaming is working');
      }
      
      setUsername(config.username);
    } catch (error) {
      console.error('Connection failed:', error);
      setError(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  };

  const handleSendMessage = (message: ChatMessage) => {
    webRTCService.sendChatMessage(message);
    setMessages((prev) => [...prev, message]);
  };

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      {!connected ? (
        <>
          {error && (
            <Alert 
              severity="error" 
              sx={{ mb: 2 }}
              action={
                <Button 
                  color="inherit" 
                  size="small"
                  onClick={() => {
                    setError(null);
                    setConnecting(false);
                  }}
                >
                  Try Again
                </Button>
              }
            >
              {error}
            </Alert>
          )}
          {connecting ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 4 }}>
              <CircularProgress size={60} />
              <Typography variant="h6" sx={{ mt: 2 }}>Connecting to server...</Typography>
              {showCancelButton && (
                <Button 
                  variant="text" 
                  color="primary"
                  sx={{ mt: 2 }}
                  onClick={() => {
                    setConnecting(false);
                    webRTCService.disconnect();
                  }}
                >
                  Cancel
                </Button>
              )}
            </Box>
          ) : (
            <ConnectionForm onConnect={handleConnect} />
          )}
        </>
      ) : (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            {streamStarted ? (
              <Alert severity="success">Stream started successfully! Check the server logs.</Alert>
            ) : (
              <Alert severity="info">Setting up stream...</Alert>
            )}
          </Grid>
          <Grid item xs={12} md={8}>
            <Box sx={{ width: '100%', aspectRatio: '16/9', bgcolor: 'black', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              <Typography variant="h5" color="white">
                Video Stream Active
              </Typography>
            </Box>
          </Grid>
          <Grid item xs={12} md={4}>
            <Chat
              username={username}
              messages={messages}
              onSendMessage={handleSendMessage}
            />
          </Grid>
        </Grid>
      )}
    </Container>
  );
}; 