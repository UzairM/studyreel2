import moondream as md

from PIL import Image



# initialize with a downloaded model

model = md.vl(model="./moondream-2b-int8.mf")
# open an image
image = Image.open("./img.jpg")

# query the image
result = model.query(image, "Describe this image")
print("Answer: ", result["answer"])