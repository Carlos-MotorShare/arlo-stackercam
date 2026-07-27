import sharp from "sharp";
sharp("./test.jpg").metadata().then(m => {
  console.log("raw dimensions:", m.width, "x", m.height);
  console.log("EXIF orientation tag:", m.orientation);
});