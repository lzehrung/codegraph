global using System.Text;
global using Shared;
global using TextBuilder = Shared.TextBuilder;
global using static Shared.TextUtilities;

class GlobalUsingProgram
{
    static void Main()
    {
        SharedType instance = new();
        TextBuilder.Build();
        Format();
        _ = new StringBuilder();
    }
}
