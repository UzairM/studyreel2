export interface User {
  username: string;
  id?: string;
}

export interface ChatMessage {
  sender: string;
  content: string;
  timestamp: number;
}

export interface StreamConfig {
  serverUrl: string;
  username: string;
  videoFile?: File;
} 