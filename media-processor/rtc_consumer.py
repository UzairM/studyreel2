import asyncio
import logging
import uuid
from typing import Dict, Any, Optional, Callable, List
import av
import fractions
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.contrib.media import MediaBlackhole, MediaRecorder
import json

logger = logging.getLogger(__name__)

class RTCConsumer:
    def __init__(
        self,
        socket,
        producer_id: str,
        stream_id: str,
        transport_id: str,
        rtp_capabilities: Dict[str, Any],
        ice_parameters: Dict[str, Any],
        ice_candidates: List[Dict[str, Any]],
        dtls_parameters: Dict[str, Any]
    ):
        self.id = str(uuid.uuid4())
        self.socket = socket
        self.producer_id = producer_id
        self.stream_id = stream_id
        self.transport_id = transport_id
        self.rtp_capabilities = rtp_capabilities
        self.ice_parameters = ice_parameters
        self.ice_candidates = ice_candidates
        self.dtls_parameters = dtls_parameters
        
        self.pc = RTCPeerConnection()
        self.consumer_id = None
        self.track = None
        self.on_frame = None  # Callback for when a frame is received
        
        # For stats
        self.frames_received = 0
        self.last_frame_time = 0
        self.fps = 0
        
    async def start(self):
        """Start the RTC consumer"""
        logger.info(f"Starting RTC consumer for producer {self.producer_id}")
        
        # Set up ICE candidates
        for candidate in self.ice_candidates:
            self.pc.addIceCandidate(candidate)
            
        # Set up track handlers
        @self.pc.on("track")
        async def on_track(track):
            logger.info(f"Track received: {track.kind}")
            self.track = track
            
            if track.kind == "video":
                asyncio.create_task(self._process_video_track(track))
                
        # Create consumer
        try:
            consumer_data = await self.socket.call('consume', {
                'transportId': self.transport_id,
                'producerId': self.producer_id,
                'rtpCapabilities': self.rtp_capabilities
            })
            
            if not consumer_data or isinstance(consumer_data, dict) and 'error' in consumer_data:
                logger.error(f"Failed to create consumer: {consumer_data}")
                return False
                
            self.consumer_id = consumer_data.get('id')
            
            if not self.consumer_id:
                logger.error("No consumer ID received")
                return False
                
            # Create SDP offer
            sdp = {
                'type': 'answer',
                'sdp': consumer_data.get('localSdp')
            }
            
            # Set remote description
            await self.pc.setRemoteDescription(RTCSessionDescription(sdp['type'], sdp['sdp']))
            
            # Create local description
            offer = await self.pc.createOffer()
            await self.pc.setLocalDescription(offer)
            
            # Connect transport
            await self.socket.call('connectTransport', {
                'transportId': self.transport_id,
                'dtlsParameters': self.dtls_parameters
            })
            
            logger.info(f"Consumer {self.consumer_id} started for producer {self.producer_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error starting consumer: {e}", exc_info=True)
            return False
            
    async def _process_video_track(self, track):
        """Process video frames from the track"""
        logger.info(f"Processing video track for consumer {self.consumer_id}")
        
        while True:
            try:
                frame = await track.recv()
                
                # Convert to numpy array for OpenCV processing
                img = frame.to_ndarray(format="bgr24")
                
                # Update stats
                self.frames_received += 1
                current_time = asyncio.get_event_loop().time()
                if self.last_frame_time > 0:
                    time_diff = current_time - self.last_frame_time
                    if time_diff > 0:
                        self.fps = 0.7 * self.fps + 0.3 * (1.0 / time_diff)  # Smooth FPS
                self.last_frame_time = current_time
                
                # Call the frame callback if set
                if self.on_frame:
                    self.on_frame(img, {
                        'consumer_id': self.consumer_id,
                        'producer_id': self.producer_id,
                        'stream_id': self.stream_id,
                        'timestamp': current_time,
                        'width': frame.width,
                        'height': frame.height
                    })
                    
            except Exception as e:
                if "End of file" in str(e) or "Stream ended" in str(e):
                    logger.info(f"Video track ended for consumer {self.consumer_id}")
                    break
                else:
                    logger.error(f"Error processing video frame: {e}", exc_info=True)
                    await asyncio.sleep(1)  # Avoid tight loop on errors
                    
    async def stop(self):
        """Stop the RTC consumer"""
        logger.info(f"Stopping RTC consumer {self.consumer_id}")
        
        # Close the peer connection
        await self.pc.close()
        
        # Close the consumer on the server
        if self.consumer_id:
            try:
                await self.socket.call('closeConsumer', {
                    'consumerId': self.consumer_id
                })
            except Exception as e:
                logger.error(f"Error closing consumer: {e}")
                
    def get_stats(self):
        """Get consumer stats"""
        return {
            'frames_received': self.frames_received,
            'fps': self.fps
        } 