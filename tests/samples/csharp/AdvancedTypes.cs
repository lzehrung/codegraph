namespace Advanced {
  public interface IRunnable {
    void Run();
  }

  public class Toolbox {
    public class NestedTool {
      public void Execute() {}
    }
  }

  public enum Mode {
    Fast,
    Slow
  }
}
