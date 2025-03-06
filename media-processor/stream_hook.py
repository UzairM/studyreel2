import socketio
import asyncio
import json
import logging
import os
import time
from datetime import datetime
import uuid
from typing import Dict, Any, Optional, List

from rtc_consumer import RTCConsumer
from video_processor import VideoProcessor

logger = logging.getLogger(__name__)

class StreamHook:
    def __init__(
        self, 
        server_url="http://localhost:3001", 
        frames_dir="./frames",
        openai_api_key=None,
        gpt_model="gpt-4o",
        frame_analysis_interval=5,
        max_frame_history=10,
        auto_detect=True  # New parameter to control auto detection
    ):
        self.sio = socketio.AsyncClient()
        self.server_url = server_url
        self.frames_dir = frames_dir
        self.openai_api_key = openai_api_key
        self.gpt_model = gpt_model
        self.frame_analysis_interval = frame_analysis_interval
        self.max_frame_history = max_frame_history
        self.auto_detect = auto_detect
        
        self.setup_event_handlers()
        
        # Track streams and consumers
        self.streams = {}  # streamId -> stream info
        self.consumers = {}  # consumerId -> RTCConsumer
        self.video_processors = {}  # streamId -> VideoProcessor
        
        # Track commands for each stream
        self.stream_commands = {}  # streamId -> {command: bool}
        
        # Create frames directory
        os.makedirs(frames_dir, exist_ok=True)
        
    def setup_event_handlers(self):
        """Set up Socket.IO event handlers"""
        @self.sio.event
        async def connect():
            logger.info(f"Connected to server: {self.server_url}")
            # Get list of current producers/streams
            await self.sio.emit('getProducers', callback=self.handle_producers)
            
        @self.sio.event
        async def disconnect():
            logger.info("Disconnected from server")
            await self.cleanup_all()
            
        @self.sio.event
        async def newProducer(data):
            logger.info(f"New producer detected: {data}")
            producer_id = data.get('producerId')
            stream_id = data.get('streamId')
            kind = data.get('kind')
            
            if producer_id and stream_id:
                if stream_id not in self.streams:
                    self.streams[stream_id] = {
                        'producers': {},
                        'start_time': time.time(),
                        'commands': {
                            'auto_detect': self.auto_detect,  # Initialize with global setting
                            'snapshot': False,
                        }
                    }
                
                self.streams[stream_id]['producers'][producer_id] = {
                    'kind': kind,
                    'id': producer_id
                }
                
                await self.process_new_producer(stream_id, producer_id, kind)
                
        @self.sio.event
        async def producerClosed(data):
            producer_id = data.get('producerId')
            stream_id = data.get('streamId')
            
            if producer_id and stream_id:
                logger.info(f"Producer {producer_id} for stream {stream_id} closed")
                
                # Remove the producer from our tracking
                if stream_id in self.streams and producer_id in self.streams[stream_id]['producers']:
                    del self.streams[stream_id]['producers'][producer_id]
                
                # If no more producers for this stream, clean up
                if stream_id in self.streams and not self.streams[stream_id]['producers']:
                    await self.cleanup_stream(stream_id)
        
        @self.sio.event
        async def chatMessage(data):
            stream_id = data.get('streamId')
            message = data.get('message', {})
            
            if stream_id and message:
                await self.process_chat_message(stream_id, message)
    
    async def handle_producers(self, producers):
        """Handle the list of existing producers"""
        if isinstance(producers, dict) and 'error' in producers:
            logger.error(f"Error getting producers: {producers['error']}")
            return
            
        logger.info(f"Received {len(producers)} existing producers")
        
        # Group producers by stream ID
        streams = {}
        for producer in producers:
            producer_id = producer.get('id')
            stream_id = producer.get('streamId')
            kind = producer.get('kind')
            
            if not (producer_id and stream_id):
                continue
                
            if stream_id not in streams:
                streams[stream_id] = {
                    'producers': {},
                    'start_time': time.time(),
                    'commands': {
                        'auto_detect': self.auto_detect,  # Initialize with global setting
                        'snapshot': False,
                    }
                }
            
            streams[stream_id]['producers'][producer_id] = {
                'kind': kind,
                'id': producer_id
            }
        
        # Store streams and process each one
        self.streams = streams
        
        for stream_id, stream_info in streams.items():
            logger.info(f"Processing existing stream: {stream_id} with {len(stream_info['producers'])} producers")
            
            # Process each producer in the stream
            for producer_id, producer_info in stream_info['producers'].items():
                await self.process_new_producer(stream_id, producer_id, producer_info['kind'])
    
    async def process_new_producer(self, stream_id: str, producer_id: str, kind: str):
        """Process a new producer when it's detected"""
        logger.info(f"Processing new producer: {producer_id} ({kind}) for stream {stream_id}")
        
        # We're only interested in video producers for OpenCV processing
        if kind != 'video':
            logger.info(f"Ignoring non-video producer: {producer_id}")
            return
            
        # Get router RTP capabilities
        rtpCapabilities = await self.sio.call('getRtpCapabilities')
        
        if not rtpCapabilities or isinstance(rtpCapabilities, dict) and 'error' in rtpCapabilities:
            logger.error(f"Failed to get RTP capabilities: {rtpCapabilities}")
            return
            
        # Create a consumer for this producer
        try:
            # Create a transport for consuming
            transport_options = await self.sio.call('createWebRtcTransport', {
                'consuming': True,
                'producing': False
            })
            
            if not transport_options or isinstance(transport_options, dict) and 'error' in transport_options:
                logger.error(f"Failed to create transport: {transport_options}")
                return
                
            transport_id = transport_options.get('id')
            
            if not transport_id:
                logger.error("No transport ID received")
                return
                
            # Create an RTC consumer
            consumer = RTCConsumer(
                socket=self.sio,
                producer_id=producer_id,
                stream_id=stream_id,
                transport_id=transport_id,
                rtp_capabilities=rtpCapabilities,
                ice_parameters=transport_options.get('iceParameters'),
                ice_candidates=transport_options.get('iceCandidates'),
                dtls_parameters=transport_options.get('dtlsParameters')
            )
            
            # Store the consumer
            self.consumers[consumer.id] = consumer
            
            # Create a video processor for this stream if it doesn't exist
            if stream_id not in self.video_processors:
                stream_dir = os.path.join(self.frames_dir, stream_id)
                os.makedirs(stream_dir, exist_ok=True)
                
                self.video_processors[stream_id] = VideoProcessor(
                    stream_id=stream_id,
                    frames_dir=stream_dir,
                    on_processed_frame=self.on_frame_processed,
                    openai_api_key=self.openai_api_key,
                    gpt_model=self.gpt_model,
                    frame_analysis_interval=self.frame_analysis_interval,
                    max_frame_history=self.max_frame_history
                )
            
            # Connect the consumer to the video processor
            consumer.on_frame = self.video_processors[stream_id].process_frame
            
            # Start the consumer
            await consumer.start()
            
            # Send a welcome message to the stream
            await self.send_chat_message(stream_id, {
                "type": "system",
                "text": "Media processor is now monitoring this stream",
                "timestamp": time.time()
            })
            
            # Inform about auto-detection status
            auto_detect_status = "enabled" if self.auto_detect else "disabled"
            await self.send_chat_message(stream_id, {
                "type": "system",
                "text": f"Auto-detection is {auto_detect_status}. All analysis results will be sent to chat.",
                "timestamp": time.time()
            })
            
            # Send available commands
            await self.send_chat_message(stream_id, {
                "type": "system",
                "text": "Available commands: !stats, !analyze, !snapshot, !auto (toggle auto-detection), !help",
                "timestamp": time.time()
            })
            
        except Exception as e:
            logger.error(f"Error setting up consumer for producer {producer_id}: {e}", exc_info=True)
    
    def on_frame_processed(self, stream_id: str, frame_info: Dict[str, Any]):
        """Callback when a frame has been processed"""
        # This is called from the video processor when a frame has been processed
        
        # Check if auto-detection is enabled for this stream
        auto_detect_enabled = self.streams.get(stream_id, {}).get('commands', {}).get('auto_detect', self.auto_detect)
        
        # If analysis was performed
        if (stream_id in self.streams and 
            'analysis' in frame_info and 
            frame_info['analysis'].get('analyzed', False)):
            
            analysis = frame_info['analysis']
            
            # If auto-detection is enabled, send all analysis results to chat
            if auto_detect_enabled:
                messages = []
                
                # Add OCR text if available
                if 'ocr_text' in analysis and analysis['ocr_text']:
                    # Truncate if too long
                    ocr_text = analysis['ocr_text']
                    if len(ocr_text) > 100:
                        ocr_text = ocr_text[:97] + "..."
                    messages.append(f"OCR: {ocr_text}")
                
                # Add app detection if available
                if 'app_detected' in analysis and analysis['app_detected']:
                    messages.append(f"App: {analysis['app_detected']}")
                
                # Add activity status if available
                if 'activity_status' in analysis:
                    messages.append(f"Status: {analysis['activity_status']}")
                
                # Add events if available
                if 'events' in analysis and analysis['events']:
                    events = analysis['events']
                    # Format the events for display
                    event_texts = [
                        f"{e.get('type', 'unknown')} ({e.get('confidence', 0):.2f}): {e.get('details', '')}"
                        for e in events if e.get('confidence', 0) > 0.5  # Only include events with confidence > 0.5
                    ]
                    
                    if event_texts:
                        messages.append("Events: " + "; ".join(event_texts[:3]))  # Show up to 3 events
                
                # Add anti-patterns if available
                if 'anti_patterns' in analysis and analysis['anti_patterns']:
                    anti_patterns = analysis['anti_patterns']
                    # Format the anti-patterns for display
                    anti_pattern_texts = [
                        f"{p.get('type', 'unknown')} ({p.get('confidence', 0):.2f})"
                        for p in anti_patterns if p.get('confidence', 0) > 0.5  # Only include patterns with confidence > 0.5
                    ]
                    
                    if anti_pattern_texts:
                        messages.append("Anti-patterns: " + ", ".join(anti_pattern_texts))
                
                # Add speed bumps if available
                if 'speed_bumps' in analysis and analysis['speed_bumps']:
                    speed_bumps = analysis['speed_bumps']
                    # Format the speed bumps for display
                    speed_bump_texts = [
                        f"{b.get('type', 'unknown')} ({b.get('confidence', 0):.2f})"
                        for b in speed_bumps if b.get('confidence', 0) > 0.5  # Only include bumps with confidence > 0.5
                    ]
                    
                    if speed_bump_texts:
                        messages.append("Speed bumps: " + ", ".join(speed_bump_texts))
                
                # Send the combined message if we have any content
                if messages:
                    combined_message = " | ".join(messages)
                    asyncio.create_task(self.send_chat_message(stream_id, {
                        "type": "system",
                        "text": combined_message,
                        "timestamp": time.time()
                    }))
    
    async def process_chat_message(self, stream_id: str, message: Dict[str, Any]):
        """Process incoming chat messages"""
        # Only process user messages that might be commands
        if message.get('type') != 'user':
            return
            
        text = message.get('text', '').strip().lower()
        
        # Check if this is a command
        if not text.startswith('!'):
            return
            
        command = text[1:].split()[0]  # Get the command without the !
        
        if command == 'help':
            await self.send_chat_message(stream_id, {
                "type": "system",
                "text": "Available commands: !stats, !analyze, !snapshot, !auto (toggle auto-detection), !help",
                "timestamp": time.time()
            })
            
        elif command == 'stats':
            # Calculate stream duration
            duration = 0
            if stream_id in self.streams:
                duration = int(time.time() - self.streams[stream_id].get('start_time', time.time()))
                
            # Get processor stats if available
            processor_stats = ""
            if stream_id in self.video_processors:
                stats = self.video_processors[stream_id].get_stats()
                processor_stats = f" | FPS: {stats.get('fps', 0):.1f} | Frames: {stats.get('frames', 0)}"
                
                if 'frames_analyzed' in stats:
                    processor_stats += f" | Analyzed: {stats.get('frames_analyzed', 0)}"
                    
                if 'gpt_events_detected' in stats:
                    processor_stats += f" | Events: {stats.get('gpt_events_detected', 0)}"
                
            # Add auto-detection status
            auto_detect_status = self.streams.get(stream_id, {}).get('commands', {}).get('auto_detect', self.auto_detect)
            auto_status = "enabled" if auto_detect_status else "disabled"
            
            await self.send_chat_message(stream_id, {
                "type": "system",
                "text": f"Stream active for {duration//60}m {duration%60}s{processor_stats} | Auto-detection: {auto_status}",
                "timestamp": time.time()
            })
            
        elif command == 'analyze':
            # Show recent events
            if stream_id in self.video_processors:
                events = self.video_processors[stream_id].get_events(5)  # Get last 5 events
                
                if events:
                    await self.send_chat_message(stream_id, {
                        "type": "system",
                        "text": f"Recent events ({len(events)}):",
                        "timestamp": time.time()
                    })
                    
                    for event in events:
                        await self.send_chat_message(stream_id, {
                            "type": "system",
                            "text": f"- {event.get('type', 'unknown')} ({event.get('confidence', 0):.2f}): {event.get('details', '')}",
                            "timestamp": time.time()
                        })
                else:
                    await self.send_chat_message(stream_id, {
                        "type": "system",
                        "text": "No events detected yet",
                        "timestamp": time.time()
                    })
                    
        elif command == 'auto':
            # Toggle auto-detection
            if stream_id in self.streams:
                current = self.streams.get(stream_id, {}).get('commands', {}).get('auto_detect', self.auto_detect)
                self.streams.setdefault(stream_id, {}).setdefault('commands', {})['auto_detect'] = not current
                
                status = "enabled" if not current else "disabled"
                await self.send_chat_message(stream_id, {
                    "type": "system",
                    "text": f"Auto-detection {status}",
                    "timestamp": time.time()
                })
                
        elif command == 'snapshot':
            # Take a snapshot of the current frame
            if stream_id in self.video_processors:
                filename = await self.video_processors[stream_id].save_snapshot()
                if filename:
                    await self.send_chat_message(stream_id, {
                        "type": "system",
                        "text": f"Snapshot saved: {os.path.basename(filename)}",
                        "timestamp": time.time()
                    })
                else:
                    await self.send_chat_message(stream_id, {
                        "type": "system",
                        "text": "Failed to save snapshot",
                        "timestamp": time.time()
                    })
    
    async def send_chat_message(self, stream_id: str, message: Dict[str, Any]):
        """Send a chat message to a specific stream"""
        await self.sio.emit('chatMessage', {
            'streamId': stream_id,
            'message': message
        })
        logger.debug(f"Sent message to stream {stream_id}: {message.get('text', '')}")
    
    async def cleanup_stream(self, stream_id: str):
        """Clean up resources for a specific stream"""
        logger.info(f"Cleaning up stream {stream_id}")
        
        # Close video processor
        if stream_id in self.video_processors:
            self.video_processors[stream_id].close()
            del self.video_processors[stream_id]
            
        # Close consumers for this stream
        consumers_to_remove = []
        for consumer_id, consumer in self.consumers.items():
            if consumer.stream_id == stream_id:
                await consumer.stop()
                consumers_to_remove.append(consumer_id)
                
        for consumer_id in consumers_to_remove:
            del self.consumers[consumer_id]
            
        # Remove stream from tracking
        if stream_id in self.streams:
            del self.streams[stream_id]
            
    async def cleanup_all(self):
        """Clean up all resources"""
        logger.info("Cleaning up all resources")
        
        # Close all consumers
        for consumer in self.consumers.values():
            await consumer.stop()
            
        # Close all video processors
        for processor in self.video_processors.values():
            processor.close()
            
        # Clear all tracking
        self.consumers.clear()
        self.video_processors.clear()
        self.streams.clear()
    
    async def start(self):
        """Connect to the server and start processing"""
        await self.sio.connect(self.server_url)
        logger.info("Stream hook started")
        
        # Keep the connection alive
        try:
            while True:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            logger.info("Shutting down...")
        finally:
            await self.cleanup_all()

    async def stop(self):
        """Disconnect from the server"""
        await self.cleanup_all()
        await self.sio.disconnect()
        logger.info("Stream hook stopped") 