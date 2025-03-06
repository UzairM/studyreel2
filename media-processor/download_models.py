#!/usr/bin/env python3
import os
import urllib.request
import logging
import sys
import zipfile
import tarfile
import shutil

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("model-downloader")

# Model URLs
MODEL_URLS = {
    "ssd_mobilenet": {
        "config": "https://raw.githubusercontent.com/opencv/opencv_extra/master/testdata/dnn/ssd_mobilenet_v3_large_coco_2020_01_14.pbtxt",
        "weights": "https://github.com/opencv/opencv_extra/raw/master/testdata/dnn/frozen_inference_graph.pb"
    }
}

def download_file(url, destination):
    """Download a file from a URL to a destination"""
    try:
        logger.info(f"Downloading {url} to {destination}")
        
        # Create directory if it doesn't exist
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        
        # Download with progress reporting
        def report_progress(block_num, block_size, total_size):
            read_so_far = block_num * block_size
            if total_size > 0:
                percent = read_so_far * 100 / total_size
                s = f"\rDownloading: {percent:.1f}% ({read_so_far} / {total_size} bytes)"
                sys.stdout.write(s)
                sys.stdout.flush()
                
        urllib.request.urlretrieve(url, destination, reporthook=report_progress)
        sys.stdout.write("\n")
        return True
    except Exception as e:
        logger.error(f"Error downloading {url}: {e}")
        return False

def main():
    """Download all required model files"""
    logger.info("Starting model download")
    
    # Create models directory
    models_dir = os.path.join(os.path.dirname(__file__), "models")
    os.makedirs(models_dir, exist_ok=True)
    
    # Download SSD MobileNet model
    ssd_config_path = os.path.join(models_dir, "ssd_mobilenet_v3_large_coco_2020_01_14.pbtxt")
    ssd_weights_path = os.path.join(models_dir, "frozen_inference_graph.pb")
    
    download_file(MODEL_URLS["ssd_mobilenet"]["config"], ssd_config_path)
    download_file(MODEL_URLS["ssd_mobilenet"]["weights"], ssd_weights_path)
    
    logger.info("Model download complete")

if __name__ == "__main__":
    main() 