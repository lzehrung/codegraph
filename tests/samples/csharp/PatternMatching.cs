namespace Sample
{
    public class Widget
    {
        public void Check(object o)
        {
            if (o is string text)
            {
                System.Console.WriteLine(text);
            }
        }
    }
}
