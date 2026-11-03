using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;

namespace JunBridge.Utils;

public class EventBus {
  // Dictionary to store event handlers. Key is event name, value is a set of handlers
  private readonly ConcurrentDictionary<string, ConcurrentDictionary<Delegate, byte>> eventHandlers = new();
  // Set of handlers that should be removed after first execution
  private readonly ConcurrentDictionary<Delegate, byte> oneTimeHandlers = new();

  // Set of events that should be captured when fired
  private readonly ConcurrentDictionary<string, byte> eventsToCapture = new();
  // Dictionary to store captured events and their data
  private readonly ConcurrentDictionary<string, object> capturedEvents = new();

  public void Fire(string eventName) {
    // Save event if it was marked for capture
    if (eventsToCapture.ContainsKey(eventName)) {
      capturedEvents[eventName] = null;
    }

    // Execute handlers if any
    if (eventHandlers.TryGetValue(eventName, out var handlers)) {
      foreach (var (handler, _) in handlers) {
        try {
          if (oneTimeHandlers.TryRemove(handler, out _)) {
            RemoveListener(eventName, (EventHandler)handler);
          }

          ((EventHandler)handler)();
        } catch (Exception e) {
          OnError(eventName, e);
        }
      }
    }
  }

  public void Fire<T>(string eventName, T args) {
    // Save event if it was marked for capture
    if (eventsToCapture.ContainsKey(eventName)) {
      capturedEvents[eventName] = args;
    }

    // Execute handlers if any
    if (eventHandlers.TryGetValue(eventName, out var handlers)) {
      foreach (var (handler, _) in handlers) {
        try {
          if (oneTimeHandlers.TryRemove(handler, out _)) {
            RemoveListener(eventName, (EventHandler<T>)handler);
          }

          ((EventHandler<T>)handler)(args);
        } catch (Exception e) {
          OnError(eventName, e);
        }
      }
    }
  }

  public void AddListener(string eventName, EventHandler handler) {
    var handlers = eventHandlers.GetOrAdd(eventName, _ => new());
    handlers.TryAdd(handler, 0);
  }

  public void AddListener<T>(string eventName, EventHandler<T> handler) {
    var handlers = eventHandlers.GetOrAdd(eventName, _ => new());
    handlers.TryAdd(handler, 0);
  }

  public void AddOneTimeListener(string eventName, EventHandler handler) {
    oneTimeHandlers.TryAdd(handler, 0);
    AddListener(eventName, handler);
  }

  public void AddOneTimeListener<T>(string eventName, EventHandler<T> handler) {
    oneTimeHandlers.TryAdd(handler, 0);
    AddListener(eventName, handler);
  }

  public void RemoveListener(string eventName, EventHandler handler) {
    if (eventHandlers.TryGetValue(eventName, out var handlers)) {
      handlers.TryRemove(handler, out _);
      if (handlers.IsEmpty) {
        eventHandlers.TryRemove(eventName, out _);
      }
    }
  }

  public void RemoveListener<T>(string eventName, EventHandler<T> handler) {
    if (eventHandlers.TryGetValue(eventName, out var handlers)) {
      handlers.TryRemove(handler, out _);
      if (handlers.IsEmpty) {
        eventHandlers.TryRemove(eventName, out _);
      }
    }
  }

  public void Capture(string eventName) {
    eventsToCapture.TryAdd(eventName, 0);
  }

  public void ReleaseCapture(string eventName) {
    eventsToCapture.TryRemove(eventName, out _);
  }

  public async Task WaitFor(string eventName) {
    ReleaseCapture(eventName);
    if (capturedEvents.TryRemove(eventName, out _)) {
      return;
    }

    var tcs = new TaskCompletionSource<object>();
    AddOneTimeListener(eventName, () => tcs.TrySetResult(null));
    await tcs.Task;
  }

  public async Task<T> WaitFor<T>(string eventName) {
    ReleaseCapture(eventName);
    if (capturedEvents.TryRemove(eventName, out var capturedEvent)) {
      return capturedEvent is T typedEvent ? typedEvent : default;
    }

    var tcs = new TaskCompletionSource<object>();
    AddOneTimeListener<T>(eventName, args => tcs.TrySetResult(args));
    var result = await tcs.Task;
    return result is T typedResult ? typedResult : default;
  }

  private void OnError(string eventName, Exception exception) {
    throw new EventException($"Error handling event '{eventName}'", exception);
  }

  public delegate void EventHandler();

  public delegate void EventHandler<T>(T args);

  public class EventException(string message, Exception innerException) : Exception(message, innerException) { }
}
