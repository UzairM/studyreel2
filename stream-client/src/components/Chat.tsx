import React, { useState, useRef, useEffect } from 'react';
import { Box, TextField, Button, Paper, Typography } from '@mui/material';
import { ChatMessage } from '../types';

interface ChatProps {
  username: string;
  onSendMessage: (message: ChatMessage) => void;
  messages: ChatMessage[];
}

export const Chat: React.FC<ChatProps> = ({ username, onSendMessage, messages }) => {
  console.log('%c[Chat] Component rendering', 'background: #2a6a8a; color: white; padding: 4px;', { messagesCount: messages.length });
  const [message, setMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    console.log('%c[Chat] Messages updated', 'background: #2a6a8a; color: white; padding: 4px;', messages);
    scrollToBottom();
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) {
      console.log('%c[Chat] Submitting message', 'background: #2a6a8a; color: #ffff00; padding: 4px; font-weight: bold;', message.trim());
      const chatMessage = {
        sender: username,
        content: message.trim(),
        timestamp: Date.now(),
      };
      console.log('%c[Chat] Created message object', 'background: #2a6a8a; color: #ffff00; padding: 4px;', chatMessage);
      onSendMessage(chatMessage);
      console.log('%c[Chat] Called onSendMessage callback', 'background: #2a6a8a; color: #ffff00; padding: 4px;', 'Complete');
      setMessage('');
    }
  };

  return (
    <Paper elevation={3} sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, overflowY: 'auto', mb: 2, maxHeight: 'calc(100vh - 200px)' }}>
        {messages.map((msg, index) => (
          <Box
            key={index}
            sx={{
              mb: 1,
              p: 1,
              backgroundColor: msg.sender === username ? '#e3f2fd' : '#f5f5f5',
              borderRadius: 1,
            }}
          >
            <Typography variant="caption" component="div" color="textSecondary">
              {msg.sender}
            </Typography>
            <Typography variant="body1">{msg.content}</Typography>
            <Typography variant="caption" color="textSecondary">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </Typography>
          </Box>
        ))}
        <div ref={messagesEndRef} />
      </Box>
      <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', gap: 1 }}>
        <TextField
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type a message..."
          fullWidth
          size="small"
        />
        <Button type="submit" variant="contained" disabled={!message.trim()}>
          Send
        </Button>
      </Box>
    </Paper>
  );
}; 