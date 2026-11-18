// Build with the .NET Framework compiler included in Windows.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

internal static class WindowsInput
{
    [StructLayout(LayoutKind.Sequential)]
    struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct MonitorInfo { public int Size; public Rect Bounds, WorkArea; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)]
    struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct KeyboardInput { public ushort VirtualKey, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputData {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Input { public uint Type; public InputData Data; }

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point pt, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr handle, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);

    static IntPtr target;
    static Rect bounds;
    static readonly HashSet<int> keys = new HashSet<int>();
    static readonly HashSet<int> buttons = new HashSet<int>();
    static readonly uint[] buttonDown = { 0x0002, 0x0020, 0x0008 };
    static readonly uint[] buttonUp = { 0x0004, 0x0040, 0x0010 };

    static bool SelectDisplay(string[] args)
    {
        int x, y, width, height;
        if (args.Length != 4 || !int.TryParse(args[0], out x) || !int.TryParse(args[1], out y)
            || !int.TryParse(args[2], out width) || !int.TryParse(args[3], out height)
            || width < 1 || height < 1) return false;
        target = MonitorFromPoint(new Point { X = x + width / 2, Y = y + height / 2 }, 0);
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (target == IntPtr.Zero || !GetMonitorInfo(target, ref info)) return false;
        bounds = info.Bounds;
        // DIP to physical pixel conversion can round an edge by one or two pixels.
        return Math.Abs(bounds.Left - x) <= 2 && Math.Abs(bounds.Top - y) <= 2
            && Math.Abs(bounds.Right - x - width) <= 2 && Math.Abs(bounds.Bottom - y - height) <= 2;
    }

    static void CheckDisplay()
    {
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (!GetMonitorInfo(target, ref info) || !bounds.Equals(info.Bounds))
            throw new InvalidOperationException("所选显示器已经变更，请重新共享。");
    }

    static bool Position(string xText, string yText)
    {
        double x, y;
        if (!double.TryParse(xText, NumberStyles.Float, CultureInfo.InvariantCulture, out x)
            || !double.TryParse(yText, NumberStyles.Float, CultureInfo.InvariantCulture, out y)
            || !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return false;
        int px = bounds.Left + (int)Math.Round(x * (bounds.Right - bounds.Left - 1));
        int py = bounds.Top + (int)Math.Round(y * (bounds.Bottom - bounds.Top - 1));
        if (!SetCursorPos(px, py))
            throw new InvalidOperationException("系统拒绝了鼠标输入。");
        return true;
    }

    static void Post(Input input)
    {
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
            throw new InvalidOperationException("系统拒绝了键鼠输入，请回到普通桌面后重新连接。");
    }

    static void Mouse(uint flags, int data)
    {
        Post(new Input { Type = 0, Data = new InputData {
            Mouse = new MouseInput { Flags = flags, Data = unchecked((uint)data) }
        }});
    }

    static void Key(int code, bool down)
    {
        if (!down && !keys.Contains(code)) return;
        uint flags = 0x0008; // KEYEVENTF_SCANCODE
        if ((code & 0x100) != 0) flags |= 0x0001;
        if (!down) flags |= 0x0002;
        Post(new Input { Type = 1, Data = new InputData {
            Keyboard = new KeyboardInput { Scan = (ushort)(code & 0xff), Flags = flags }
        }});
        if (down) keys.Add(code); else keys.Remove(code);
    }

    static void Button(int button, bool down)
    {
        if (buttons.Contains(button) == down) return;
        Mouse(down ? buttonDown[button] : buttonUp[button], 0);
        if (down) buttons.Add(button); else buttons.Remove(button);
    }

    static void Reset()
    {
        foreach (int button in new List<int>(buttons))
            try { Button(button, false); } catch (InvalidOperationException) {}
        foreach (int key in new List<int>(keys))
            try { Key(key, false); } catch (InvalidOperationException) {}
    }

    static void Handle(string line)
    {
        string[] p = line.Split(' ');
        if (p[0] == "reset") { Reset(); return; }
        CheckDisplay();
        int id, dx, dy;
        switch (p[0]) {
            case "key":
                if (p.Length == 3 && int.TryParse(p[1], out id) && id > 0 && id < 512)
                    Key(id, p[2] == "1");
                break;
            case "move":
                if (p.Length == 3) Position(p[1], p[2]);
                break;
            case "button":
                if (p.Length == 5 && int.TryParse(p[1], out id) && id >= 0 && id <= 2 && Position(p[3], p[4]))
                    Button(id, p[2] == "1");
                break;
            case "wheel":
                if (p.Length == 5 && int.TryParse(p[1], out dx) && int.TryParse(p[2], out dy)
                    && dx >= -1000 && dx <= 1000 && dy >= -1000 && dy <= 1000 && Position(p[3], p[4])) {
                    if (dy != 0) Mouse(0x0800, -dy);
                    if (dx != 0) Mouse(0x1000, dx);
                }
                break;
        }
    }

    static int Main(string[] args)
    {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--check") { Console.WriteLine("ALLOWED"); return 0; }
        try {
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4)) || !SelectDisplay(args))
                throw new InvalidOperationException("无法识别所选显示器，请重新选择。");
            Console.WriteLine("READY");
            string line;
            while ((line = Console.ReadLine()) != null) Handle(line);
            return 0;
        } catch (Exception e) {
            Console.WriteLine("ERROR " + e.Message);
            return 1;
        } finally { Reset(); }
    }
}
