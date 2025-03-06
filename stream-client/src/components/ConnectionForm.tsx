import React, { useState } from 'react';
import { Box, TextField, Button, Paper } from '@mui/material';
import { StreamConfig } from '../types';

interface ConnectionFormProps {
  onConnect: (config: StreamConfig) => void;
}

export const ConnectionForm: React.FC<ConnectionFormProps> = ({ onConnect }) => {
  const [serverUrl, setServerUrl] = useState('http://localhost:3001');
  const [username, setUsername] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (serverUrl && username && videoFile) {
      onConnect({
        serverUrl,
        username,
        videoFile,
      });
    }
  };

  return (
    <Paper elevation={3} sx={{ p: 3, maxWidth: 400, mx: 'auto', mt: 4 }}>
      <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField
          label="Server URL"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          required
          fullWidth
        />
        <TextField
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          fullWidth
        />
        <input
          accept="video/*"
          style={{ display: 'none' }}
          id="video-file"
          type="file"
          onChange={(e) => setVideoFile(e.target.files?.[0] || null)}
        />
        <label htmlFor="video-file">
          <Button variant="contained" component="span" fullWidth>
            {videoFile ? videoFile.name : 'Select Video File'}
          </Button>
        </label>
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={!serverUrl || !username || !videoFile}
          fullWidth
        >
          Connect
        </Button>
      </Box>
    </Paper>
  );
}; 