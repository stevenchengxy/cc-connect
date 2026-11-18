using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// Runs only in the isolated manual CI job. No remote input, network code,
// arbitrary coordinates or user-supplied keystrokes are accepted by this test.
internal static class NativeWindowCheck
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetFocus();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    static readonly Color Start = Color.FromArgb(45, 61, 190);
    static readonly Color Click = Color.FromArgb(47, 180, 85);
    static readonly Color Typed = Color.FromArgb(200, 71, 59);
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static void Pump() { Application.DoEvents(); Thread.Sleep(15); }
    static bool OwnsTarget(Form f, Point center, Point sample) {
        return f.Visible && f.Focused && !f.IsDisposed && GetForegroundWindow()==f.Handle &&
            GetFocus()==f.Handle && WindowFromPoint(center)==f.Handle && WindowFromPoint(sample)==f.Handle;
    }
    static int Skip(string why) { Console.WriteLine("SKIPPED: " + why); return 77; }
    static bool Pixel(Point sample, Color expected) {
        // Read a single pixel in our solid test window. No desktop image is saved or exported.
        using (var image=new Bitmap(1,1)) {
            using (var g=Graphics.FromImage(image)) g.CopyFromScreen(sample, Point.Empty, new Size(1,1));
            return image.GetPixel(0,0).ToArgb()==expected.ToArgb();
        }
    }
    static bool Observe(Func<bool> condition, int timeout) {
        long end=clock.ElapsedMilliseconds+timeout;
        do { Pump(); if(condition()) return true; } while(clock.ElapsedMilliseconds<end);
        return false;
    }
    static void Require(bool ok, string why) { if(!ok) throw new InvalidOperationException(why); }

    [STAThread] static int Main() {
        if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true" || Environment.GetEnvironmentVariable("CC_QA_RUNNER_CLASS")!="github-hosted" ||
           Environment.GetEnvironmentVariable("RUNNER_OS")!="Windows" || !Environment.UserInteractive || Process.GetCurrentProcess().SessionId==0)
            return Skip("No isolated interactive GitHub-hosted Windows session");
        try {
            if(!SetProcessDpiAwarenessContext(new IntPtr(-4))) return Skip("Physical desktop coordinates unavailable");
            using(var f=new Form()) return Check(f);
        } catch(Exception e) { Console.Error.WriteLine("FAILED: "+e.GetType().Name+" "+e.Message); return 1; }
    }
    static int Check(Form f) {
        Rectangle screen=Screen.PrimaryScreen.Bounds;
        if(screen.Width<400 || screen.Height<300) return Skip("No usable display");
        f.FormBorderStyle=FormBorderStyle.None;
        f.StartPosition=FormStartPosition.Manual;
        f.Bounds=new Rectangle(screen.Left+(screen.Width-300)/2,screen.Top+(screen.Height-220)/2,300,220);
        f.Text="CC Connect isolated native input check"; f.TopMost=true; f.KeyPreview=true; f.BackColor=Start;
        bool down=false,up=false,aDown=false,aUp=false;
        f.MouseDown+=(s,e)=> { down=e.Button==MouseButtons.Left && Math.Abs(e.X-150)<=2 && Math.Abs(e.Y-110)<=2; };
        f.MouseUp+=(s,e)=> { if(down && e.Button==MouseButtons.Left) {up=true; f.BackColor=Click; f.Refresh();} };
        f.KeyDown+=(s,e)=> { if(up && e.KeyData==Keys.A) aDown=true; };
        f.KeyUp+=(s,e)=> { if(aDown && e.KeyData==Keys.A) {aUp=true; f.BackColor=Typed; f.Refresh();} };
        f.Show(); f.Activate(); f.Focus(); f.Refresh();
        Point center=f.PointToScreen(new Point(150,110)), sample=f.PointToScreen(new Point(95,70));
        if(!Observe(()=>OwnsTarget(f,center,sample),2000)) return Skip("The fixture cannot obtain foreground keyboard and mouse focus");
        try { if(!Pixel(sample,Start)) return Skip("Fixture pixels unavailable on the Windows desktop"); }
        catch(System.ComponentModel.Win32Exception) { return Skip("Windows desktop capture unavailable"); }
        var ci=CultureInfo.InvariantCulture;
        var exe=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"jianping-input.exe");
        var info=new ProcessStartInfo(exe,string.Format(ci,"{0} {1} {2} {3}",screen.Left,screen.Top,screen.Width,screen.Height));
        info.UseShellExecute=false; info.CreateNoWindow=true; info.RedirectStandardInput=true; info.RedirectStandardOutput=true;
        using(var helper=Process.Start(info)) {
            try {
                var ready=helper.StandardOutput.ReadLineAsync();
                Require(ready.Wait(5000) && ready.Result=="READY","Release helper failed to initialize");
                double x=(double)(center.X-screen.Left)/(screen.Width-1), y=(double)(center.Y-screen.Top)/(screen.Height-1);
                string point=x.ToString("R",ci)+" "+y.ToString("R",ci);
                if(!OwnsTarget(f,center,sample)) return Skip("Fixture lost focus before input");
                // One click inside the owned form. Wait for release and visibly updated pixels.
                helper.StandardInput.WriteLine("button 0 1 "+point); helper.StandardInput.WriteLine("button 0 0 "+point); helper.StandardInput.Flush();
                Require(Observe(()=>up,3000),"Test form did not receive center click");
                if(!OwnsTarget(f,center,sample)) return Skip("Fixture lost focus before KeyA");
                Require(Pixel(sample,Click),"Clicked window did not show expected color");
                // Physical KeyA is the single fixed scan code used in this fixture.
                helper.StandardInput.WriteLine("key 30 1"); helper.StandardInput.WriteLine("key 30 0"); helper.StandardInput.Flush();
                Require(Observe(()=>aUp,3000),"Test form did not receive KeyA press and release");
                if(!OwnsTarget(f,center,sample)) return Skip("Fixture lost focus before pixel verification");
                Require(Pixel(sample,Typed),"Window pixels did not change after KeyA");
                Console.WriteLine("PASS: released Windows helper delivered center click and KeyA; observed both color changes in the fixture window.");
                return 0;
            } finally {
                try { helper.StandardInput.Close(); } catch(IOException) { }
                if(!helper.WaitForExit(2500)) {helper.Kill(); helper.WaitForExit();}
            }
        }
    }
}
