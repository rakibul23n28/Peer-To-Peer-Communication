import { OrbitMark } from './OrbitMark';

export function EmptyConversationState({ onFindSomeone }: { onFindSomeone: () => void }) {
  return <div className="orbit-empty-state">
    <div className="orbit-empty-orbit" aria-hidden="true">
      <span className="orbit-art-ring orbit-art-ring--one" />
      <span className="orbit-art-ring orbit-art-ring--two" />
      <span className="orbit-art-core"><OrbitMark /></span>
    </div>
    <p>No conversations yet</p>
    <button className="orbit-primary-action" type="button" onClick={onFindSomeone}>Find someone by username</button>
  </div>;
}
