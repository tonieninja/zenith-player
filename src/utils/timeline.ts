/** frontend side of the qa playback timeline (epoch ms + label) */
const marks: [number, string][] = [];

export function tmark(label: string): void {
  if (marks.length > 600) marks.splice(0, 200);
  marks.push([Date.now(), label]);
}

export function timelineMarks(): [number, string][] {
  return marks.slice();
}
