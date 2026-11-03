// slice.video официального API не имеет — режим собирает готовую заявку
// (тема, визуал, голос, стиль) и отдаёт её, чтобы один кликом вставить в slice.video.

export function buildRequest({ topic, visuals, whoSpeaks, length, voiceover, captions, visualStyle }) {
  const lines = [
    `What's your video about:`,
    topic,
    ``,
    `Visuals: ${visuals}`,
    `Who speaks: ${whoSpeaks}`,
    `Length: ${length}`,
    `Voiceover: ${voiceover || "auto"}`,
    `Captions: ${captions ? "on" : "off"}`,
    `Visual style: ${visualStyle}`,
  ];
  return {
    url: "https://slice.video",
    text: lines.join("\n"),
    title: topic.slice(0, 60),
  };
}
