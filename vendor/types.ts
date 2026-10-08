// Types the vendored companion renderer expects (the same shapes as bot-companions' server).
export interface Bot {
  id: string;
  name: string;
  avatar: { color: string; shape: string; expression: string; motion: string };
  mainThreadId: string | null;
}
export type Work = 'run' | 'read' | 'search' | 'web' | 'edit' | 'tool';
