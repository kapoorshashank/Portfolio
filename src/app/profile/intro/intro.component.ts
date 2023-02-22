import { trigger, transition, style, animate } from '@angular/animations';
import { AfterViewInit, Component, OnInit, ViewChild } from '@angular/core';
import Typewriter from 't-writer.js';
export const fadeInOut = (name = 'fadeInOut', duration = 0.1) =>
  trigger(name, [
    transition(':enter', [
      style({ opacity: 0 }),
      animate(`${duration}s ease-in-out`)
    ]),
    transition(':leave', [animate(`${duration}s ease-in-out`, style({ opacity: 0 }))])
  ])
@Component({
  selector: 'app-intro',
  templateUrl: './intro.component.html',
  styleUrls: ['./intro.component.scss'],
  animations: [
    fadeInOut('fadeInOut-1', 2),
    fadeInOut('fadeInOut-2', 3),
    fadeInOut('fadeInOut-3', 4),
    fadeInOut('fadeInOut-0', 1)
  ]
})
export class IntroComponent implements OnInit, AfterViewInit {
  @ViewChild('tw') typewriterElement;
  @ViewChild('tw2') typewriterElement2;
  @ViewChild('tw3') typewriterElement3;
  @ViewChild('ts') typewriterElements;
  @ViewChild('ts2') typewriterElements2;
  @ViewChild('ts3') typewriterElements3;
  show = true;
  constructor() { }
  isMobile = false;
  getIsMobile(): boolean {
    const w = document.documentElement.clientWidth;
    const breakpoint = 992;
    console.log(w);
    if (w < breakpoint) {
      return true;
    } else {
      return false;
    }
  }
  ngOnInit(): void {
    this.isMobile = this.getIsMobile();
    window.onresize = () => {
      this.isMobile = this.getIsMobile();
      
    };

  }

//   openBracket(string)
//   {
//   const res = open(string)
//   {
//     debugger;
//     const stack = []; //create a stack to push and pop
//     for(let val of string){
//       if(val ==='(')
//       {
//         stack.push(val);
//         console.log("stack push"+JSON.stringify(stack));
//       }
//       if(val ===')'){
//         stack.pop();
//         console.log("stack pop"+JSON.stringify(stack));

//       }
//     }
//     return stack.length == 0;
//   }
// }
  ngAfterViewInit() {
    const target2 = this.typewriterElement2.nativeElement;
    const target3 = this.typewriterElement3.nativeElement;
    const target = this.typewriterElement.nativeElement;
    const targets2 = this.typewriterElements2.nativeElement;
    const targets3 = this.typewriterElements3.nativeElement;
    const targets = this.typewriterElements.nativeElement;

    const writer = new Typewriter(target, {
      loop: true,
      typeColor: 'white',
      typeSpeed: 60,
      deleteSpeed: 10,
    })
    const writers = new Typewriter(targets, {
      loop: true,
      typeColor: 'white'
    })

    writer.strings(
      "",
      // "I like to code things from scratch.    ",
      "I enjoy bringing ideas to life in the browser.     ",
      "I value simple content structure.    ",
      "I like clean design patterns.    ",
      "I like thoughtful interactions."
    )
      .start()
    // .type(`I enjoy bringing ideas to life in the browser. I like to code things from scratch.`)

    // .rest()
    // .start()
    // .clear()

    // .then(writers.start.bind(writers))
    // .start()

    //   writers
    //     .type(`
    //     I value simple content structure, clean design patterns, and thoughtful interactions.

    // `)
    //     .rest()
    //     .start()
    // I value simple content structure, clean design patterns, and thoughtful interactions.
    const writer2 = new Typewriter(target2, {
      typeColor: ''

    })

    const writer3 = new Typewriter(target3, {
      typeColor: 'red'
    })

    // writer2
    // .type('I like to ')
    // .removeCursor()
    // .then(writer3.start.bind(writer3))
    // .start()

    // writer3
    // .type("code things from scratch.")
    // .rest(500)
    // .clear()
    // .changeTypeColor('red')
    // .type("enjoy bringing ideas to life in the browser")
    // .rest(500)
    // .clear()
    // .changeTypeColor('blue')
    // .type(" create simple content structure, clean design patterns, and thoughtful interactions.")
    // .rest(500)
    // .clear()
    // .changeTypeColor('black')
    // .then(writer2.start.bind(writer2))
  }
}
