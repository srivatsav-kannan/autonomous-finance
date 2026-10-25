# Source and traineddata are pinned by SHA256; this target provides OCR/rendering,
# not the application or proof of production deployment readiness.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl cmake g++ make pkg-config libleptonica-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.2.tar.gz -o tesseract.tar.gz && echo '6235ea0dae45ea137f59c09320406f5888383741924d98855bd2ce0d16b54f21  tesseract.tar.gz' | sha256sum -c - && tar -xzf tesseract.tar.gz
RUN cmake -S tesseract-5.5.2 -B out -DCMAKE_BUILD_TYPE=Release -DBUILD_TRAINING_TOOLS=OFF -DBUILD_TESTS=OFF && cmake --build out -j2 && cmake --install out
RUN mkdir -p /usr/local/share/tessdata && curl -fsSL https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata -o /usr/local/share/tessdata/eng.traineddata && echo '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  /usr/local/share/tessdata/eng.traineddata' | sha256sum -c -
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends liblept5 libgomp1 libarchive13 libcurl4 poppler-utils ca-certificates python3 python3-pil && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local /usr/local
RUN ldconfig && tesseract --version && echo '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  /usr/local/share/tessdata/eng.traineddata' | sha256sum -c -
ENV AP_TESSERACT=/usr/local/bin/tesseract AP_TESSDATA_ENG=/usr/local/share/tessdata/eng.traineddata AP_PDFTOPPM=/usr/bin/pdftoppm AP_PDFINFO=/usr/bin/pdfinfo
ENTRYPOINT ["/usr/local/bin/tesseract"]
