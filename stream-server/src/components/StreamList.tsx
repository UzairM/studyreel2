import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Stream {
  id: string;
  kind: string;
}

interface StreamListProps {
  streams: Stream[];
  onStreamSelect: (streamId: string) => void;
}

export const StreamList: React.FC<StreamListProps> = ({ streams, onStreamSelect }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {streams.map((stream) => (
        <Card key={stream.id}>
          <CardHeader>
            <CardTitle>Stream {stream.id}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Type: {stream.kind}
            </p>
            <Button onClick={() => onStreamSelect(stream.id)}>
              Watch Stream
            </Button>
          </CardContent>
        </Card>
      ))}
      {streams.length === 0 && (
        <div className="col-span-full text-center text-muted-foreground">
          No active streams available
        </div>
      )}
    </div>
  );
}; 