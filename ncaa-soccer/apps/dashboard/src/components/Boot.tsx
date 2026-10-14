/** The screen shown before the first render, and when the API cannot be reached. */
export function Boot({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="boot" role={onRetry ? 'alert' : 'status'}>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="pager-button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

