import { OrbitMark } from './OrbitMark';

export function EmptyConversationState({ onFindSomeone }: { onFindSomeone: () => void }) {
  return <div className="orbit-empty-state">
    <div className="orbit-empty-garden" aria-hidden="true">
      <span className="garden-sun" />
      <span className="garden-cloud garden-cloud--one" />
      <span className="garden-cloud garden-cloud--two" />
      <span className="garden-hill garden-hill--back" />
      <span className="garden-hill garden-hill--front" />
      <span className="garden-sprout"><OrbitMark /></span>
      <span className="garden-flower garden-flower--one" />
      <span className="garden-flower garden-flower--two" />
    </div>
    <p>Your garden is ready to grow.</p>
    <span className="orbit-empty-caption">Invite someone in and start a little conversation.</span>
    <button className="orbit-primary-action" type="button" onClick={onFindSomeone}>Find someone by username</button>
  </div>;
}
