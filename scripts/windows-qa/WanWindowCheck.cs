using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

// A disposable CI form. Its inbox has exactly two fixed operations, in order.
// The only HWND ever eligible for message dispatch is the one created below.
internal static class WanWindowCheck
{
    [DllImport("user32.dll",SetLastError=true)] static extern bool PostMessage(IntPtr h,uint msg,IntPtr wParam,IntPtr lParam);
    static readonly Color Red = Color.FromArgb(229,38,38), Green = Color.FromArgb(38,229,38), Blue = Color.FromArgb(38,38,229);
    internal static int Run() {
        using(var f=new Form()) {
            var screen=Screen.PrimaryScreen.Bounds;
            if(screen.Width<360 || screen.Height<280) return 77;
            f.FormBorderStyle=FormBorderStyle.None; f.AutoScaleMode=AutoScaleMode.None;
            f.StartPosition=FormStartPosition.Manual; f.TopMost=true; f.KeyPreview=true;
            f.Bounds=new Rectangle(screen.Left+(screen.Width-320)/2,screen.Top+(screen.Height-240)/2,320,240);
            f.Text="CC Connect owned Windows WAN fixture"; f.BackColor=Red;
            int phase=0,dispatch=0; bool down=false,pressed=false,blink=false;
            Point center=new Point(160,120);
            f.Paint+=(s,e)=> {
                e.Graphics.FillRectangle(blink ? Brushes.White : Brushes.Black,0,0,16,16);
                e.Graphics.DrawString("CC Connect Windows QA",SystemFonts.DefaultFont,Brushes.White,100,165);
            };
            f.MouseDown+=(s,e)=>{if(phase==0 && dispatch==1 && e.Button==MouseButtons.Left && e.Location==center)down=true;};
            f.MouseUp+=(s,e)=>{if(phase==0 && down && e.Location==center && e.Button==MouseButtons.Left){phase=1;f.BackColor=Green;f.Refresh();}};
            f.KeyDown+=(s,e)=>{if(phase==1 && dispatch==2 && e.KeyData==Keys.A)pressed=true;};
            f.KeyUp+=(s,e)=>{if(phase==1 && pressed && e.KeyData==Keys.A){phase=2;f.BackColor=Blue;f.Refresh();}};
            f.Show();f.Activate();f.Focus();f.Refresh();
            Point target=f.PointToScreen(center),sample=f.PointToScreen(new Point(80,80));
            Func<bool> owned=()=>NativeWindowCheck.OwnsTarget(f,target,sample);
            if(!NativeWindowCheck.Observe(owned,3000) || !NativeWindowCheck.Pixel(sample,Red))return 77;
            Console.WriteLine("READY");
            var clock=Stopwatch.StartNew(); long nextFrame=0;
            Task<string> cmd=Task.Run(()=>Console.ReadLine());
            while(clock.ElapsedMilliseconds<420000) {
                Application.DoEvents();
                if(!owned())return 77;
                if(cmd.IsCompleted) {
                    string line=cmd.Result;
                    if(line==null || line=="END")return phase==2 ? 0 : 1;
                    if(line=="CENTER_CLICK" && phase==0 && dispatch==0) {
                        dispatch=1;var point=new IntPtr((center.Y<<16)|center.X);
                        if(!PostMessage(f.Handle,0x0201,new IntPtr(1),point)||!PostMessage(f.Handle,0x0202,IntPtr.Zero,point))return 1;
                        if(!NativeWindowCheck.Observe(()=>phase==1,3000) || !owned() || !NativeWindowCheck.Pixel(sample,Green))return 1;
                        Console.WriteLine("CONFIRMED_CLICK");
                    } else if(line=="KEY_A" && phase==1 && dispatch==1) {
                        dispatch=2;
                        if(!PostMessage(f.Handle,0x0100,new IntPtr(0x41),new IntPtr(0x001e0001)) || !PostMessage(f.Handle,0x0101,new IntPtr(0x41),new IntPtr(unchecked((int)0xc01e0001))))return 1;
                        if(!NativeWindowCheck.Observe(()=>phase==2,3000) || !owned() || !NativeWindowCheck.Pixel(sample,Blue))return 1;
                        Console.WriteLine("CONFIRMED_KEY_A");
                    } else return 1;
                    cmd=Task.Run(()=>Console.ReadLine());
                }
                if(clock.ElapsedMilliseconds>=nextFrame) {
                    blink=!blink; f.Refresh();nextFrame=clock.ElapsedMilliseconds+150;
                    // Render this form only. The separately verified physical screen sample is one pixel.
                    using(var bitmap=new Bitmap(320,240))using(var mem=new MemoryStream()) {
                        f.DrawToBitmap(bitmap,new Rectangle(0,0,320,240));
                        bitmap.Save(mem,ImageFormat.Png);Console.WriteLine("FRAME "+Convert.ToBase64String(mem.ToArray()));
                    }
                }
                System.Threading.Thread.Sleep(12);
            }
            return 1;
        }
    }
}
