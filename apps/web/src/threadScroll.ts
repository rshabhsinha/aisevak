export interface ScrollPosition {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isThreadScrollNearBottom(position: ScrollPosition, threshold = 72): boolean {
  return position.scrollHeight - position.scrollTop - position.clientHeight <= threshold;
}
